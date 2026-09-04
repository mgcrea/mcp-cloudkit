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

describe("requests", () => {
  it("authenticates with the management token header, not a bearer token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ recordTypes: [] }));
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });

    const headers = harness.initAt().headers as Record<string, string>;
    expect(headers["X-Apple-CloudKit-User-Token"]).toBe("test-token");
    expect(headers.Authorization).toBeUndefined();
  });

  it("builds the environment-scoped record types path from the configured defaults", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ recordTypes: [] }));
    const harness = await connectConfigured(
      { CLOUDKIT_CONTAINER_ID: "iCloud.io.mgcrea.Balise" },
      fetchImpl,
    );
    await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });

    expect(harness.urlAt()).toBe(
      "https://api.icloud.apple.com/v1/database/teams/75QE9PRT3V/containers/" +
        "iCloud.io.mgcrea.Balise/environments/DEVELOPMENT/recordTypes",
    );
  });

  it("explains what to do when no container is configured or passed", async () => {
    const harness = await connectConfigured();
    const result = await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });
    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("CLOUDKIT_CONTAINER_ID");
  });

  it("shapes record types down to their fields", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        recordTypes: [
          {
            name: "CD_Track",
            fields: [
              { name: "CD_isHidden", fieldType: "INT64", queryable: true, extra: "dropped" },
              { name: "CD_name", fieldType: "STRING" },
            ],
          },
        ],
      }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_list_record_types", { environment: "DEVELOPMENT" });

    expect(body).toMatchObject({
      recordTypes: [
        {
          name: "CD_Track",
          fields: [
            { name: "CD_isHidden", type: "INT64", queryable: true },
            { name: "CD_name", type: "STRING" },
          ],
        },
      ],
    });
  });

  it("filters to one record type when asked", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        recordTypes: [
          { name: "CD_Track", fields: [] },
          { name: "CD_Waypoint", fields: [] },
        ],
      }),
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
  it("flattens a diff to one row per field change", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        recordTypeChanges: [
          {
            recordType: "CD_Track",
            operation: "UPDATE",
            fieldChanges: [{ field: "CD_isHidden", operation: "ADD" }],
          },
          {
            recordType: "CD_Waypoint",
            operation: "UPDATE",
            fieldChanges: [{ field: "CD_isHidden", operation: "ADD" }],
          },
        ],
      }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");

    expect(body).toMatchObject({
      changes: [
        { operation: "ADD", recordType: "CD_Track", field: "CD_isHidden" },
        { operation: "ADD", recordType: "CD_Waypoint", field: "CD_isHidden" },
      ],
    });
  });

  it("reports a whole new record type as a single row", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ recordTypeChanges: [{ recordType: "CD_Layer", operation: "ADD" }] }),
    );
    const harness = await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const body = await harness.call("cloudkit_diff_schema");
    expect(body).toMatchObject({ changes: [{ operation: "ADD", recordType: "CD_Layer" }] });
  });

  it("distinguishes an empty diff from an unreadable one", async () => {
    const empty = vi.fn(async () => jsonResponse({ recordTypeChanges: [] }));
    const emptyBody = await (
      await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, empty)
    ).call("cloudkit_diff_schema");
    expect(emptyBody).toMatchObject({ changes: [] });

    const unknown = vi.fn(async () => jsonResponse({ delta: "surprise" }));
    const unknownBody = await (
      await connectConfigured({ CLOUDKIT_CONTAINER_ID: "C" }, unknown)
    ).call("cloudkit_diff_schema");
    expect(unknownBody).toMatchObject({ delta: "surprise" });
  });
});

/** Stubs the diff read every cloudkit_deploy_schema call makes first, then delegates. */
const diffThen = (rest: (url: string) => Response) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.endsWith("/schema/diff")) {
      return jsonResponse({
        recordTypeChanges: [
          {
            recordType: "CD_Track",
            operation: "UPDATE",
            fieldChanges: [{ field: "CD_isHidden", operation: "ADD" }],
          },
        ],
      });
    }
    return rest(url);
  });

describe("cloudkit_deploy_schema", () => {
  it("returns the diff and promotes nothing on a dry run", async () => {
    const fetchImpl = diffThen(() => jsonResponse({}));
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
    const fetchImpl = diffThen(() => jsonResponse({}));
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", {});
    expect(result.isToolError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses when there is nothing to deploy", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ recordTypeChanges: [] }),
    );
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("Nothing to deploy");
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes("/promote"))).toBe(true);
  });

  it("promotes the development schema uuid read off the container", async () => {
    const fetchImpl = diffThen((url) =>
      url.endsWith("/containers/iCloud.io.mgcrea.Balise")
        ? jsonResponse({ developmentSchemaUUID: "dev-uuid-1", productionSchemaUUID: "prod-uuid" })
        : jsonResponse({ ok: true }),
    );
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

  it("names both paths it looked in when the schema uuid is nowhere", async () => {
    const fetchImpl = diffThen(() => jsonResponse({ noUuidHere: true }));
    const harness = await connectWithWrites({ CLOUDKIT_CONTAINER_ID: "C" }, fetchImpl);
    const result = await harness.call("cloudkit_deploy_schema", { confirm: true });

    expect(result.isToolError).toBe(true);
    expect(result.error).toContain("development schema UUID");
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
