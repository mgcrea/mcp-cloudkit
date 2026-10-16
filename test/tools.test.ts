import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  connect,
  connectConfigured,
  connectWithWrites,
  jsonResponse,
  textResponse,
} from "#test/helpers";

const READ_TOOLS = [
  "cloudkit_auth_status",
  "cloudkit_diff_schema",
  "cloudkit_export_schema",
  "cloudkit_list_containers",
  "cloudkit_list_record_types",
  "cloudkit_request",
  "cloudkit_validate_schema",
];

describe("with no credentials configured", () => {
  // The regression that produces "MCP error -32000: Connection closed": a
  // server that exits on startup takes the credential-free tools with it and
  // leaves no way to discover what to configure.
  it("still connects, and serves only the tool that needs no credentials", async () => {
    expect(await (await connect()).toolNames()).toEqual(["cloudkit_auth_status"]);
  });

  it("registers nothing when the token is set but the team id is not", async () => {
    const harness = await connect({ CLOUDKIT_MANAGEMENT_TOKEN: "t" });
    expect(await harness.toolNames()).toEqual(["cloudkit_auth_status"]);
  });

  it("answers cloudkit_auth_status as a setup guide", async () => {
    const res = await (await connect()).call("cloudkit_auth_status");
    expect(res.configured).toBe(false);
    expect((res.setup as string[]).join(" ")).toContain("CLOUDKIT_MANAGEMENT_TOKEN");
  });
});

describe("tool registration matrix", () => {
  it("registers the read tools, and no write tools, with writes disabled", async () => {
    expect(await (await connectConfigured()).toolNames()).toEqual(READ_TOOLS);
  });

  it("adds the write tools only when writes are enabled", async () => {
    const names = await (await connectWithWrites()).toolNames();
    expect(names).toEqual(
      [...READ_TOOLS, "cloudkit_deploy_schema", "cloudkit_import_schema"].toSorted(),
    );
  });

  it("reports configuration through auth_status", async () => {
    const res = await (await connectConfigured()).call("cloudkit_auth_status");
    expect(res.configured).toBe(true);
    expect(res.managementToken).toBe("set");
    expect(res.teamId).toBe("75QE9PRT3V");
    expect(res.setup).toEqual([]);
  });
});

type FieldSpec = { type?: string; indexes?: ("QUERYABLE" | "SEARCHABLE" | "SORTABLE")[] };

/**
 * A `GET …/environments/{env}/schema` response, in the shape Apple actually
 * returns — captured from a live container, not guessed. Fields carry their
 * indexes as `isQueryable`/`isSearchable`/`isSortable`, and system fields
 * (`___recordID` and friends) come back alongside the user's own.
 */
const schemaResponse = (
  uuid: string,
  recordTypes: Record<string, Record<string, FieldSpec>>,
  textSchema = `DEFINE SCHEMA ${uuid}`,
) => ({
  schema: {
    uuid,
    createdAt: "2026-09-03T11:21:33.369Z",
    roles: [{ id: 0, name: "_world", type: "DEFAULT_ROLE" }],
    textSchema,
    recordTypes: Object.entries(recordTypes).map(([recordTypeName, fields]) => ({
      recordTypeName,
      recordIdType: "STRING",
      indexes: [],
      roles: [],
      fields: [
        ...Object.entries(fields).map(([name, spec]) => ({
          name,
          type: spec.type ?? "stringType",
          isQueryable: spec.indexes?.includes("QUERYABLE") ?? false,
          isSearchable: spec.indexes?.includes("SEARCHABLE") ?? false,
          isSortable: spec.indexes?.includes("SORTABLE") ?? false,
          isUserCreated: true,
        })),
        {
          name: "___recordID",
          systemFieldName: "recordName",
          type: "referenceType",
          isQueryable: false,
          isSearchable: false,
          isSortable: false,
          isUserCreated: false,
        },
      ],
    })),
  },
});

/** Answers each environment's schema read from its own fixture. */
const schemas = (
  development: unknown,
  production: unknown,
  rest: (url: string, init?: RequestInit) => Response = () => jsonResponse({}),
) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/environments/DEVELOPMENT/schema")) return jsonResponse(development);
    if (url.endsWith("/environments/PRODUCTION/schema")) return jsonResponse(production);
    return rest(url, init);
  });

const TRACK = { CD_name: { indexes: ["QUERYABLE", "SORTABLE"] } } satisfies Record<
  string,
  FieldSpec
>;

describe("requests", () => {
  // Read out of a live cktool session under a debugger: a management token goes
  // in X-ACP-API-TOKEN. X-Apple-CloudKit-User-Token — the only header name
  // `strings` finds in the binary — is for *user* tokens, and the API answers
  // a management token sent there with 401 "Failed to validate user token".
  it("authenticates with X-ACP-API-TOKEN, not the user-token header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ containers: [] }));
    const harness = await connectConfigured({}, fetchImpl);
    await harness.call("cloudkit_list_containers");

    const headers = harness.initAt().headers as Record<string, string>;
    expect(headers["X-ACP-API-TOKEN"]).toBe("test-token");
    expect(headers["X-CK-CLIENT"]).toMatch(/^mcp-cloudkit-js\//);
    expect(headers["X-Apple-CloudKit-User-Token"]).toBeUndefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it("lists containers from the team route, which sits outside /v1/database", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ containers: [{ id: "iCloud.io.mgcrea.Balise", teamId: "75QE9PRT3V" }] }),
    );
    const harness = await connectConfigured({}, fetchImpl);
    const body = await harness.call("cloudkit_list_containers");

    expect(harness.urlAt()).toBe("https://api.icloud.apple.com/teams/75QE9PRT3V/containers");
    expect(body).toMatchObject({ containers: [{ id: "iCloud.io.mgcrea.Balise" }] });
  });

  it("reads record types from the environment schema, built from the configured defaults", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(schemaResponse("dev", { CD_Track: TRACK })));
    const harness = await connectConfigured(
      { CLOUDKIT_CONTAINER_ID: "iCloud.io.mgcrea.Balise" },
      fetchImpl,
    );
    await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });

    // Not `…/recordTypes`: that route exists, but refuses a management token.
    expect(harness.urlAt()).toBe(
      "https://api.icloud.apple.com/v1/database/teams/75QE9PRT3V/containers/" +
        "iCloud.io.mgcrea.Balise/environments/DEVELOPMENT/schema",
    );
  });

  it("explains what to do when no container is configured or passed", async () => {
    const harness = await connectConfigured();
    const result = await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });
    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("CLOUDKIT_CONTAINER_ID");
  });

  it("shapes record types down to their fields, indexes and system flag", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        schemaResponse("dev", {
          CD_Track: {
            CD_isHidden: { type: "int64Type", indexes: ["QUERYABLE", "SORTABLE"] },
            CD_notes: {},
          },
        }),
      ),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });

    expect(body).toEqual({
      isToolError: false,
      recordTypes: [
        {
          name: "CD_Track",
          fields: [
            { name: "CD_isHidden", type: "int64Type", queryable: true, sortable: true },
            { name: "CD_notes", type: "stringType" },
            { name: "___recordID", type: "referenceType", system: true },
          ],
        },
      ],
    });
  });

  it("filters to one record type when asked", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(schemaResponse("dev", { CD_Track: {}, CD_Waypoint: {} })),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = (await harness.call("cloudkit_list_record_types", {
      environment: "DEVELOPMENT",
      recordType: "CD_Waypoint",
    })) as { recordTypes: { name: string }[] };

    expect(body.recordTypes.map((t) => t.name)).toEqual(["CD_Waypoint"]);
  });

  it("passes an unrecognised envelope through rather than reporting no record types", async () => {
    // The endpoints are undocumented. Returning `{recordTypes: []}` here would
    // read as "the field is not deployed", which is the one lie that matters.
    const fetchImpl = vi.fn(async () => jsonResponse({ somethingElse: { CD_Track: {} } }));
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });
    expect(body).toMatchObject({ somethingElse: { CD_Track: {} } });
  });

  it("returns the exported schema as text, not JSON-escaped", async () => {
    const ckdb = 'RECORD TYPE CD_Track (\n    "CD_isHidden" INT64,\n);\n';
    const fetchImpl = vi.fn(async () => textResponse(ckdb));
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const text = await harness.text("cloudkit_export_schema", { environment: "DEVELOPMENT" });

    expect(text).toBe(ckdb);
    expect(harness.urlAt()).toContain("/environments/DEVELOPMENT/schema/export");
  });

  it("surfaces the CloudKit error reason and status, not a bare failure", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse(
        { reason: "Invalid schema version.", serverErrorCode: "BAD_REQUEST" },
        { status: 400 },
      ),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_list_containers");

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("Invalid schema version.");
    const details = result.details as { status: number; serverErrorCode: string };
    expect(details.status).toBe(400);
    expect(details.serverErrorCode).toBe("BAD_REQUEST");
  });
});

describe("cloudkit_diff_schema", () => {
  // `…/schema/diff` refuses a management token, so the diff is computed here
  // from the two environments' schemas, both of which the token can read.
  it("reads both environments and reports a new field once per record type", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev", {
        CD_Track: { ...TRACK, CD_isHidden: { type: "int64Type" } },
        CD_Waypoint: { CD_isHidden: { type: "int64Type" } },
      }),
      schemaResponse("prod", { CD_Track: TRACK, CD_Waypoint: {} }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");

    expect(body).toMatchObject({
      changes: [
        { operation: "ADD", recordType: "CD_Track", field: "CD_isHidden" },
        { operation: "ADD", recordType: "CD_Waypoint", field: "CD_isHidden" },
      ],
    });
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => u.endsWith("/DEVELOPMENT/schema"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/PRODUCTION/schema"))).toBe(true);
    expect(urls.some((u) => u.includes("/schema/diff"))).toBe(false);
  });

  it("reports a whole new record type as a single row", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev", { CD_Track: TRACK, CD_Layer: { CD_name: {} } }),
      schemaResponse("prod", { CD_Track: TRACK }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");
    expect(body).toMatchObject({ changes: [{ operation: "ADD", recordType: "CD_Layer" }] });
    expect((body.changes as unknown[]).length).toBe(1);
  });

  it("names a retype, an index change and a field Production has but Development lacks", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev", {
        CD_Track: {
          CD_name: { indexes: ["QUERYABLE", "SEARCHABLE", "SORTABLE"] },
          CD_index: { type: "doubleType" },
        },
      }),
      schemaResponse("prod", {
        CD_Track: {
          CD_name: { indexes: ["QUERYABLE", "SORTABLE"] },
          CD_index: { type: "int64Type" },
          CD_legacy: {},
        },
      }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");

    expect(body).toMatchObject({
      changes: [
        {
          operation: "CHANGE_INDEXES",
          recordType: "CD_Track",
          field: "CD_name",
          detail: "QUERYABLE SORTABLE → QUERYABLE SEARCHABLE SORTABLE",
        },
        {
          operation: "RETYPE",
          recordType: "CD_Track",
          field: "CD_index",
          detail: "int64Type → doubleType",
        },
        { operation: "MISSING_IN_DEVELOPMENT", recordType: "CD_Track", field: "CD_legacy" },
      ],
    });
  });

  it("reports an empty diff when the environments agree", async () => {
    const same = schemaResponse("x", { CD_Track: TRACK }, "DEFINE SCHEMA same");
    const fetchImpl = schemas(same, same);
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    expect(await harness.call("cloudkit_diff_schema")).toMatchObject({ changes: [] });
  });

  it("never calls a differing schema empty, even when no field moved", async () => {
    // Permissions (GRANT lines) are not modelled field by field, but they deploy.
    const fetchImpl = schemas(
      schemaResponse("dev", { CD_Track: TRACK }, 'DEFINE SCHEMA … GRANT READ TO "_world"'),
      schemaResponse("prod", { CD_Track: TRACK }, "DEFINE SCHEMA …"),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    expect(await harness.call("cloudkit_diff_schema")).toMatchObject({
      changes: [{ operation: "OTHER" }],
    });
  });

  it("hands back both raw schemas when either envelope is unrecognised", async () => {
    const fetchImpl = schemas({ delta: "surprise" }, schemaResponse("prod", {}));
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");
    expect(body).toMatchObject({ development: { delta: "surprise" } });
    expect(body.changes).toBeUndefined();
  });
});

/** A Development schema one field ahead of Production. */
const pending = () =>
  schemas(
    schemaResponse("dev-uuid-1", { CD_Track: { ...TRACK, CD_isHidden: { type: "int64Type" } } }),
    schemaResponse("prod-uuid", { CD_Track: TRACK }),
  );

describe("cloudkit_deploy_schema", () => {
  it("returns the diff and promotes nothing on a dry run", async () => {
    const fetchImpl = pending();
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = (await harness.call("cloudkit_deploy_schema", {
      confirm: true,
      dryRun: true,
    })) as { dryRun: boolean; wouldDeploy: unknown[] };

    expect(body.dryRun).toBe(true);
    expect(body.wouldDeploy).toEqual([
      { operation: "ADD", recordType: "CD_Track", field: "CD_isHidden" },
    ]);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/promote"))).toBe(true);
  });

  it("refuses without confirm", async () => {
    const fetchImpl = pending();
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", {});
    expect(result.isToolError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when there is nothing to deploy", async () => {
    const same = schemaResponse("x", { CD_Track: TRACK }, "same");
    const fetchImpl = schemas(same, same);
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("Nothing to deploy");
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/promote"))).toBe(true);
  });

  it("does not count fields only Production has as something to deploy", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev", { CD_Track: TRACK }, "same"),
      schemaResponse("prod", { CD_Track: { ...TRACK, CD_legacy: {} } }, "same"),
    );
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });
    expect(result.error).toContain("Nothing to deploy");
  });

  it("refuses a retype, which Production can never accept", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev", { CD_Track: { CD_index: { type: "doubleType" } } }),
      schemaResponse("prod", { CD_Track: { CD_index: { type: "int64Type" } } }),
    );
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("RETYPE");
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/promote"))).toBe(true);
  });

  it("refuses when the schemas cannot be read, rather than deploying blind", async () => {
    const fetchImpl = schemas({ delta: "surprise" }, schemaResponse("prod", {}));
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/promote"))).toBe(true);
  });

  it("promotes the development schema's own uuid", async () => {
    const fetchImpl = pending();
    const harness = await connectWithWrites(
      { CLOUDKIT_CONTAINER_ID: "iCloud.io.mgcrea.Balise" },
      fetchImpl,
    );
    const body = (await harness.call("cloudkit_deploy_schema", { confirm: true })) as {
      deployed: boolean;
      schemaUuid: string;
    };

    expect(body.deployed).toBe(true);
    expect(body.schemaUuid).toBe("dev-uuid-1");

    const promote = fetchImpl.mock.calls.find(([url]) => String(url).includes("/promote"));
    expect(promote?.[0]).toBe(
      "https://api.icloud.apple.com/v1/database/teams/75QE9PRT3V/containers/" +
        "iCloud.io.mgcrea.Balise/schema/dev-uuid-1/promote",
    );
    expect((promote?.[1] as RequestInit | undefined)?.method).toBe("POST");
  });

  it("explains a refused promote and still returns the diff it would have deployed", async () => {
    const fetchImpl = schemas(
      schemaResponse("dev-uuid-1", { CD_Track: { ...TRACK, CD_isHidden: {} } }),
      schemaResponse("prod-uuid", { CD_Track: TRACK }),
      () => jsonResponse({ code: 401, message: "authentication-failed" }, { status: 401 }),
    );
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("CloudKit Console");
    expect(result.details).toMatchObject({
      status: 401,
      changes: [{ operation: "ADD", recordType: "CD_Track", field: "CD_isHidden" }],
    });
  });
});

/** Writes a `.ckdb` to a fresh temp dir and returns its path. */
const ckdbFile = (text = "DEFINE SCHEMA\n"): string => {
  const path = join(mkdtempSync(join(tmpdir(), "cloudkit-test-")), "dev.ckdb");
  writeFileSync(path, text, "utf8");
  return path;
};

/** The single `file` part of a multipart body, as cktool sends it. */
const filePartOf = (init: RequestInit): File => {
  expect(init.body).toBeInstanceOf(FormData);
  const part = (init.body as FormData).get("file");
  expect(part).toBeInstanceOf(File);
  return part as File;
};

// Both read out of a live cktool session: the schema goes up as one multipart
// part named `file`, and a `text/plain` body is refused with 415.
describe("schema uploads", () => {
  it("validates with a POST of the file as a multipart part", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const filePath = ckdbFile("DEFINE SCHEMA\n    RECORD TYPE CD_Track ();\n");
    await harness.call("cloudkit_validate_schema", { environment: "DEVELOPMENT", filePath });

    expect(harness.urlAt()).toContain("/environments/DEVELOPMENT/schema/validate");
    const init = harness.initAt();
    expect(init.method).toBe("POST");
    // fetch writes the multipart Content-Type, boundary included; a hand-set one would lack it.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const part = filePartOf(init);
    expect(part.name).toBe("dev.ckdb");
    expect(await part.text()).toBe("DEFINE SCHEMA\n    RECORD TYPE CD_Track ();\n");
  });

  it("imports with a PUT to the environment schema, not a POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    await harness.call("cloudkit_import_schema", {
      environment: "DEVELOPMENT",
      filePath: ckdbFile(),
      confirm: true,
    });

    expect(harness.urlAt()).toMatch(/\/environments\/DEVELOPMENT\/schema$/);
    const init = harness.initAt();
    expect(init.method).toBe("PUT");
    expect(await filePartOf(init).text()).toBe("DEFINE SCHEMA\n");
  });
});

/** The `method` enum cloudkit_request advertises, which is where write gating shows. */
const requestMethods = async (
  harness: Awaited<ReturnType<typeof connect>>,
): Promise<string[] | undefined> => {
  const tool = await harness.tool("cloudkit_request");
  if (!tool) return undefined;
  const props = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> })
    .properties;
  return props?.method?.enum;
};

describe("cloudkit_request", () => {
  it("offers only GET while writes are disabled", async () => {
    expect(await requestMethods(await connectConfigured())).toEqual(["GET"]);
  });

  it("offers the mutating methods once writes are enabled", async () => {
    expect(await requestMethods(await connectWithWrites())).toEqual([
      "GET",
      "POST",
      "PATCH",
      "DELETE",
    ]);
  });

  it("requires confirm for anything other than GET", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const harness = await connectWithWrites({}, fetchImpl);
    const result = await harness.call("cloudkit_request", {
      method: "POST",
      path: "/v1/database/teams/T/containers/C/schema/uuid/promote",
    });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("confirm");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses the container reset route, which is deliberately not a tool", async () => {
    // Omitting `reset` as a tool would mean little if the escape hatch reached it.
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const harness = await connectWithWrites({}, fetchImpl);
    const result = await harness.call("cloudkit_request", {
      method: "POST",
      confirm: true,
      path: "/v1/database/teams/T/containers/C/environments/DEVELOPMENT/reset",
    });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("deletes all data");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["a capitalised segment", "/v1/database/teams/T/containers/C/environments/DEVELOPMENT/Reset"],
    [
      "a percent-encoded segment",
      "/v1/database/teams/T/containers/C/environments/DEVELOPMENT/%72eset",
    ],
  ])("refuses the reset route spelled with %s", async (_label, path) => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const harness = await connectWithWrites({}, fetchImpl);
    const result = await harness.call("cloudkit_request", { method: "POST", confirm: true, path });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("deletes all data");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("still allows a plain GET with no confirm", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: 1 }));
    const harness = await connectConfigured({}, fetchImpl);
    const body = await harness.call("cloudkit_request", {
      path: "/v1/database/teams/T/containers",
    });

    expect(body).toMatchObject({ ok: 1 });
    expect(harness.urlAt()).toBe("https://api.icloud.apple.com/v1/database/teams/T/containers");
  });
});

/**
 * The three properties that are invisible in review and at runtime, and whose
 * absence simply makes the model guess.
 */
describe("tool contract", () => {
  it("names the service in every title, since that is what a permission dialog shows", async () => {
    const tools = (await (await connectWithWrites()).client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.title ?? "", tool.name).toMatch(/^CloudKit: /);
    }
  });

  it("describes every input field", async () => {
    const tools = (await (await connectWithWrites()).client.listTools()).tools;
    for (const tool of tools) {
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
        .properties;
      for (const [field, schema] of Object.entries(props ?? {})) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("annotates every tool, and marks the irreversible ones destructive", async () => {
    const harness = await connectWithWrites();
    const tools = (await harness.client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toBeDefined();
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("cloudkit_diff_schema")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("cloudkit_validate_schema")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("cloudkit_deploy_schema")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("cloudkit_import_schema")?.annotations?.destructiveHint).toBe(true);
  });
});
