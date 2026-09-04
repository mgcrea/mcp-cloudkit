// The CloudKit management API answers with no JSON:API wrapper, no `data`
// envelope, no `included`. Nothing here assumes any particular shape it hasn't
// verified — see the note below.
//
// Every shaper **falls back to the raw value when it does not recognise the
// shape**, and that is the load-bearing rule rather than defensive habit.
// These endpoints are undocumented (read out of the `cktool` binary's strings,
// not a published spec), so a shaper that assumed wrong would return
// `{fields: []}` — which reads as "the field is not deployed yet", the single
// most misleading answer this server could give, and indistinguishable from
// the truth it is meant to report.

export type Rec = Record<string, unknown>;

export const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One field of a record type, as the Console shows it. */
export type CloudKitField = {
  name: unknown;
  type: unknown;
  queryable?: unknown;
  sortable?: unknown;
  searchable?: unknown;
};

const FIELD_KEYS = ["name", "fieldType", "type", "queryable", "sortable", "searchable"];

const looksLikeField = (value: unknown): boolean =>
  isRecord(value) && FIELD_KEYS.some((key) => key in value);

/** Flatten one field, keeping only what distinguishes it. `type` spans both spellings. */
const summarizeField = (value: unknown): unknown => {
  if (!looksLikeField(value)) return value;
  const f = value as Rec;
  const type = f.fieldType ?? f.type;
  return {
    name: f.name,
    ...(type !== undefined ? { type } : {}),
    ...(f.queryable !== undefined ? { queryable: f.queryable } : {}),
    ...(f.sortable !== undefined ? { sortable: f.sortable } : {}),
    ...(f.searchable !== undefined ? { searchable: f.searchable } : {}),
  };
};

/** The array of fields on a record type, under either spelling, or undefined. */
const fieldsOf = (value: Rec): unknown[] | undefined => {
  for (const key of ["fields", "fieldsList", "recordFields"]) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Flatten a record type to `{name, fields: [...]}`.
 *
 * Unwraps a `{recordType: {...}}` envelope if there is one, so callers do not
 * have to know which of the two the endpoint answered with.
 */
export const summarizeRecordType = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const inner = isRecord(value.recordType) ? value.recordType : value;
  const fields = fieldsOf(inner);
  if (inner.name === undefined && fields === undefined) return value;
  return {
    name: inner.name,
    ...(fields ? { fields: fields.map(summarizeField) } : {}),
  };
};

/** The array of record types in a list response, under any of its spellings. */
export const recordTypesOf = (response: unknown): unknown[] | undefined => {
  if (Array.isArray(response)) return response;
  if (!isRecord(response)) return undefined;
  for (const key of ["recordTypes", "results", "data"]) {
    const candidate = response[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
};

/** One pending schema change, as `cloudkit_diff_schema` reports it. */
export type SchemaChange = {
  operation: unknown;
  recordType: unknown;
  field?: unknown;
};

const changeArrayOf = (value: Rec, keys: string[]): unknown[] | undefined => {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Flatten a schema diff to one row per change: `{operation, recordType, field}`.
 *
 * Returns `undefined` — not an empty array — when the response does not look
 * like a diff, so the tool can hand back what Apple actually said. An empty
 * array is a real and meaningful answer here ("nothing to deploy"), so it must
 * never double as "I could not read this".
 */
export const summarizeSchemaDiff = (response: unknown): SchemaChange[] | undefined => {
  if (!isRecord(response)) return undefined;
  const recordTypeChanges = changeArrayOf(response, [
    "recordTypeChanges",
    "recordTypes",
    "changes",
  ]);
  if (!recordTypeChanges) return undefined;

  const rows: SchemaChange[] = [];
  for (const entry of recordTypeChanges) {
    if (!isRecord(entry)) continue;
    const recordType = entry.recordType ?? entry.name;
    const operation = entry.operation ?? entry.changeType;
    const fieldChanges = changeArrayOf(entry, ["fieldChanges", "fields", "fieldOperations"]);

    // A record type added wholesale has no per-field rows worth listing; one
    // that already exists reports only the fields that moved.
    if (!fieldChanges || fieldChanges.length === 0) {
      rows.push({ operation, recordType });
      continue;
    }
    for (const change of fieldChanges) {
      if (!isRecord(change)) continue;
      rows.push({
        operation: change.operation ?? change.changeType ?? operation,
        recordType,
        field: change.field ?? change.name,
      });
    }
  }
  return rows;
};

/**
 * The development schema's UUID, which is what `promote` deploys.
 *
 * Looked for under both the container response and the environment schema
 * response because the two are near-identical envelopes and only one of them
 * carries it — which one is not documented anywhere.
 */
export const developmentSchemaUuidOf = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const candidate of [value, value.container, value.schema]) {
    if (!isRecord(candidate)) continue;
    const uuid = candidate.developmentSchemaUUID ?? candidate.developmentSchemaUuid;
    if (typeof uuid === "string" && uuid) return uuid;
  }
  return undefined;
};
