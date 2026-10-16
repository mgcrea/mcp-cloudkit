// The CloudKit management API answers with no JSON:API wrapper, no `data`
// envelope, no `included`. Nothing here assumes any particular shape it hasn't
// verified — see the note below.
//
// Every shaper **falls back to the raw value when it does not recognise the
// shape**, and that is the load-bearing rule rather than defensive habit.
// These endpoints are undocumented (read out of the `cktool` binary, not a
// published spec), so a shaper that assumed wrong would return `{fields: []}`
// — which reads as "the field is not deployed yet", the single most
// misleading answer this server could give, and indistinguishable from the
// truth it is meant to report.
//
// The shape recognised below is `GET …/environments/{env}/schema`, captured
// from a live container:
//
//   { schema: { uuid, textSchema, roles, createdAt, createdBy,
//               recordTypes: [{ recordTypeName, recordIdType, indexes, roles,
//                 fields: [{ name, type, isQueryable, isSearchable,
//                            isSortable, isUserCreated, systemFieldName? }] }] } }

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type SchemaField = Rec & { name: string };
type SchemaRecordType = Rec & { recordTypeName: string; fields: SchemaField[] };

const schemaOf = (response: unknown): Rec | undefined =>
  isRecord(response) && isRecord(response.schema) ? response.schema : undefined;

const isSchemaRecordType = (value: unknown): value is SchemaRecordType =>
  isRecord(value) &&
  typeof value.recordTypeName === "string" &&
  Array.isArray(value.fields) &&
  value.fields.every((field) => isRecord(field) && typeof field.name === "string");

/**
 * The record types in a schema response, or `undefined` when it is not one.
 * All or nothing: one unrecognised entry means the envelope is not the one
 * described above, and a partial list would silently drop a record type.
 */
export const schemaRecordTypesOf = (response: unknown): SchemaRecordType[] | undefined => {
  const types = schemaOf(response)?.recordTypes;
  if (!Array.isArray(types) || !types.every(isSchemaRecordType)) return undefined;
  return types;
};

/** The schema's own UUID, which is what `promote` deploys. */
export const schemaUuidOf = (response: unknown): string | undefined => {
  const uuid = schemaOf(response)?.uuid;
  return typeof uuid === "string" && uuid ? uuid : undefined;
};

const textSchemaOf = (response: unknown): string | undefined => {
  const text = schemaOf(response)?.textSchema;
  return typeof text === "string" ? text : undefined;
};

const INDEX_FLAGS = [
  ["isQueryable", "QUERYABLE"],
  ["isSearchable", "SEARCHABLE"],
  ["isSortable", "SORTABLE"],
] as const;

/** A field's indexes, spelled and ordered as the `.ckdb` text spells them. */
const indexesOf = (field: SchemaField): string[] =>
  INDEX_FLAGS.filter(([flag]) => field[flag] === true).map(([, index]) => index);

/**
 * One field, with only the flags that are set. `system` marks CloudKit's own
 * `___recordID`-style fields, so they do not read as something a client wrote.
 */
const summarizeField = (field: SchemaField): Rec => ({
  name: field.name,
  type: field.type,
  ...(field.isQueryable === true ? { queryable: true } : {}),
  ...(field.isSearchable === true ? { searchable: true } : {}),
  ...(field.isSortable === true ? { sortable: true } : {}),
  ...(field.isUserCreated === false ? { system: true } : {}),
});

export const summarizeRecordType = (recordType: SchemaRecordType): Rec => ({
  name: recordType.recordTypeName,
  fields: recordType.fields.map(summarizeField),
});

/**
 * What a deploy would do to one record type or field.
 *
 * - `ADD`: new in Development. The usual, safe change.
 * - `CHANGE_INDEXES`: same field, different QUERYABLE/SEARCHABLE/SORTABLE.
 * - `RETYPE`: same name, different type. Production can never accept this.
 * - `MISSING_IN_DEVELOPMENT`: Production has it and Development does not. A
 *   deploy cannot remove it, so it is reported but is not a change.
 * - `OTHER`: the `.ckdb` texts differ where no field does — permissions,
 *   mostly. Reported so a differing schema is never called empty.
 */
export type SchemaOperation =
  | "ADD"
  | "CHANGE_INDEXES"
  | "RETYPE"
  | "MISSING_IN_DEVELOPMENT"
  | "OTHER";

export type SchemaChange = {
  operation: SchemaOperation;
  recordType?: string;
  field?: string;
  detail?: string;
};

/** Operations a deploy would actually carry to Production. */
export const isDeployable = (change: SchemaChange): boolean =>
  change.operation === "ADD" ||
  change.operation === "CHANGE_INDEXES" ||
  change.operation === "OTHER";

/**
 * Development against Production, one row per change — computed here because
 * the API's own `…/schema/diff` refuses a management token.
 *
 * Returns `undefined` — not an empty array — when either response is not a
 * recognisable schema, so the tool can hand back what Apple actually said. An
 * empty array is a real and meaningful answer here ("nothing to deploy"), so
 * it must never double as "I could not read this".
 */
export const diffSchemas = (
  development: unknown,
  production: unknown,
): SchemaChange[] | undefined => {
  const dev = schemaRecordTypesOf(development);
  const prod = schemaRecordTypesOf(production);
  if (!dev || !prod) return undefined;

  const rows: SchemaChange[] = [];
  const prodTypes = new Map(prod.map((type) => [type.recordTypeName, type]));
  const devTypeNames = new Set(dev.map((type) => type.recordTypeName));

  for (const devType of dev) {
    const recordType = devType.recordTypeName;
    const prodType = prodTypes.get(recordType);
    // A record type added wholesale has no per-field rows worth listing.
    if (!prodType) {
      rows.push({ operation: "ADD", recordType });
      continue;
    }
    const prodFields = new Map(prodType.fields.map((field) => [field.name, field]));
    const devFieldNames = new Set(devType.fields.map((field) => field.name));

    for (const devField of devType.fields) {
      const field = devField.name;
      const prodField = prodFields.get(field);
      if (!prodField) {
        rows.push({ operation: "ADD", recordType, field });
      } else if (prodField.type !== devField.type) {
        rows.push({
          operation: "RETYPE",
          recordType,
          field,
          detail: `${String(prodField.type)} → ${String(devField.type)}`,
        });
      } else {
        const before = indexesOf(prodField).join(" ");
        const after = indexesOf(devField).join(" ");
        if (before !== after) {
          rows.push({
            operation: "CHANGE_INDEXES",
            recordType,
            field,
            detail: `${before || "none"} → ${after || "none"}`,
          });
        }
      }
    }
    for (const prodField of prodType.fields) {
      if (!devFieldNames.has(prodField.name)) {
        rows.push({ operation: "MISSING_IN_DEVELOPMENT", recordType, field: prodField.name });
      }
    }
  }
  for (const prodType of prod) {
    if (!devTypeNames.has(prodType.recordTypeName)) {
      rows.push({ operation: "MISSING_IN_DEVELOPMENT", recordType: prodType.recordTypeName });
    }
  }

  if (rows.length === 0) {
    const devText = textSchemaOf(development);
    const prodText = textSchemaOf(production);
    if (devText !== undefined && prodText !== undefined && devText !== prodText) {
      rows.push({
        operation: "OTHER",
        detail:
          "The schemas differ outside any field (permissions, most likely). " +
          "Compare them with cloudkit_export_schema.",
      });
    }
  }
  return rows;
};
