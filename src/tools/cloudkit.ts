import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  containerPath,
  containersPath,
  recordTypesPath,
  schemaDiffPath,
  schemaExportPath,
  schemaPath,
  schemaPromotePath,
  schemaValidatePath,
  type CloudKitClient,
  type CloudKitEnvironment,
} from "#/client/cloudkit";
import {
  developmentSchemaUuidOf,
  recordTypesOf,
  summarizeRecordType,
  summarizeSchemaDiff,
} from "#/client/shape";
import { confirmArg, dryRunArg, okText, PreconditionError, wrap, wrapResult } from "#/tools/util";

export type CloudKitToolContext = {
  teamId: string;
  /** Configured default, so the container need not be retyped on every call. */
  defaultContainerId?: string | undefined;
  allowWrites: boolean;
};

/**
 * Always required, never defaulted.
 *
 * Defaulting to PRODUCTION would be reckless; defaulting to DEVELOPMENT would be
 * worse in a quieter way, because "which environment am I looking at" is the
 * single most common source of false "sync is broken" conclusions — a Debug
 * build writes to Development and a TestFlight build to Production, and records
 * do not cross. Making it explicit costs one word and removes the whole class.
 */
const environmentArg = z
  .enum(["DEVELOPMENT", "PRODUCTION"])
  .describe(
    "Which container environment. A Debug build's data and schema live in DEVELOPMENT; " +
      "TestFlight and App Store builds use PRODUCTION. They are separate databases.",
  );

export const registerCloudKitTools = (
  server: McpServer,
  client: CloudKitClient,
  ctx: CloudKitToolContext,
): void => {
  const { teamId, defaultContainerId, allowWrites } = ctx;

  const containerArg = z
    .string()
    .min(1)
    .optional()
    .describe(
      defaultContainerId
        ? `The iCloud container id, e.g. "iCloud.com.acme.App". Defaults to ${defaultContainerId}.`
        : 'The iCloud container id, e.g. "iCloud.com.acme.App". ' +
            "Get it from cloudkit_list_containers, or set CLOUDKIT_CONTAINER_ID to default it.",
    );

  /** Resolve the container for a call, failing with what to do rather than a 404. */
  const container = (given: string | undefined): string => {
    const id = given ?? defaultContainerId;
    if (!id) {
      throw new PreconditionError(
        "No container id. Pass `containerId`, or set CLOUDKIT_CONTAINER_ID to default it.",
        { hint: "cloudkit_list_containers lists the containers this team can see." },
      );
    }
    return id;
  };

  server.registerTool(
    "cloudkit_list_containers",
    {
      title: "CloudKit: List Containers",
      description:
        "List the CloudKit containers this team can manage, with their ids. Use this to find " +
        "the container id the other cloudkit_* tools take.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => wrap(async () => client.get(containersPath(teamId))),
  );

  server.registerTool(
    "cloudkit_list_record_types",
    {
      title: "CloudKit: List Record Types",
      description:
        "List a container environment's record types and their fields. This is how you confirm " +
        "a newly added field actually reached CloudKit: Core Data and SwiftData prefix " +
        "everything with `CD_`, so a Swift property `isHidden` on `Track` appears here as " +
        "`CD_isHidden` on `CD_Track`. A field missing from DEVELOPMENT has not been written by " +
        "any client yet — there is nothing to deploy until one has.",
      inputSchema: z.object({
        environment: environmentArg,
        containerId: containerArg,
        recordType: z
          .string()
          .optional()
          .describe('Return just this one record type, e.g. "CD_Track". Omit for all of them.'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ environment, containerId, recordType }) =>
      wrap(async () => {
        const raw = await client.get(
          recordTypesPath(teamId, container(containerId), environment as CloudKitEnvironment),
        );
        const types = recordTypesOf(raw);
        if (!types) return raw;
        const shaped = types.map(summarizeRecordType);
        if (!recordType) return { recordTypes: shaped };
        return {
          recordTypes: shaped.filter(
            (t) => t && typeof t === "object" && (t as { name?: unknown }).name === recordType,
          ),
        };
      }),
  );

  server.registerTool(
    "cloudkit_export_schema",
    {
      title: "CloudKit: Export Schema",
      description:
        "Export an environment's full schema as a `.ckdb` document. Returns the text, or writes " +
        "it to `outputPath` and reports where it went. Exporting both environments and diffing " +
        "them locally is one way to review a pending change; cloudkit_diff_schema is the direct one.",
      inputSchema: z.object({
        environment: environmentArg,
        containerId: containerArg,
        outputPath: z
          .string()
          .optional()
          .describe('Write the schema here instead of returning it, e.g. "./dev.ckdb".'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ environment, containerId, outputPath }) =>
      wrapResult(async () => {
        const text = await client.requestText(
          "GET",
          schemaExportPath(teamId, container(containerId), environment as CloudKitEnvironment),
        );
        if (!outputPath) return okText(text);
        const path = resolve(outputPath);
        writeFileSync(path, text, "utf8");
        return okText(`Wrote ${text.length} bytes to ${path}`);
      }),
  );

  server.registerTool(
    "cloudkit_diff_schema",
    {
      title: "CloudKit: Diff Schema",
      description:
        "Show what deploying would change: the pending differences between the container's " +
        "DEVELOPMENT and PRODUCTION schemas, one row per change. Read this before " +
        "cloudkit_deploy_schema. Production is additive-only and irreversible — a field can be " +
        "added forever, but never removed, renamed or retyped — so a diff proposing anything " +
        "other than additions is a reason to stop.",
      inputSchema: z.object({ containerId: containerArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ containerId }) =>
      wrap(async () => {
        const raw = await client.get(schemaDiffPath(teamId, container(containerId)));
        const changes = summarizeSchemaDiff(raw);
        // `undefined` means the envelope was not recognised, which is not the
        // same as "no changes" and must not be reported as it.
        return changes ? { changes } : raw;
      }),
  );

  server.registerTool(
    "cloudkit_validate_schema",
    {
      title: "CloudKit: Validate Schema",
      description:
        "Validate a local `.ckdb` file against a container environment without importing it. " +
        "Read-only: it reports whether the schema would be accepted, and changes nothing.",
      inputSchema: z.object({
        environment: environmentArg,
        containerId: containerArg,
        filePath: z.string().min(1).describe('Path to the `.ckdb` file, e.g. "./dev.ckdb".'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ environment, containerId, filePath }) =>
      wrap(async () =>
        client.request(
          "POST",
          schemaValidatePath(teamId, container(containerId), environment as CloudKitEnvironment),
          { text: readSchemaFile(filePath) },
        ),
      ),
  );

  server.registerTool(
    "cloudkit_request",
    {
      title: "CloudKit: Raw Request",
      description:
        "Escape hatch: issue an arbitrary CloudKit management API request. The other cloudkit_* " +
        "tools cover the documented-by-observation routes; this exists because the API is " +
        "undocumented, so one endpoint being shaped differently than expected should not make " +
        "the rest unreachable. Prefer a specific tool when one fits." +
        (allowWrites
          ? " Anything other than GET requires `confirm: true`."
          : " Only GET is available while writes are disabled."),
      inputSchema: z.object({
        method: (allowWrites ? z.enum(["GET", "POST", "PATCH", "DELETE"]) : z.enum(["GET"]))
          .default("GET")
          .describe("HTTP method."),
        path: z
          .string()
          .min(1)
          .describe(
            "Absolute API path, e.g. " +
              '"/v1/database/teams/{teamId}/containers/{containerId}/environments/DEVELOPMENT/recordTypes".',
          ),
        body: z.record(z.string(), z.unknown()).optional().describe("JSON request body."),
        confirm: z
          .literal(true)
          .optional()
          .describe("Required for any method other than GET. Explicit acknowledgement of a write."),
      }),
      annotations: { readOnlyHint: !allowWrites },
    },
    async ({ method, path, body, confirm }) =>
      wrap(async () => {
        // Enforced here rather than in the schema so the common GET case stays
        // frictionless: zod cannot make one field's requiredness depend on another.
        if (method !== "GET" && confirm !== true) {
          throw new PreconditionError(
            `${method} through cloudkit_request requires confirm: true.`,
            { method, path },
          );
        }
        assertNotDestructive(path);
        return client.request(method, path, body !== undefined ? { body } : {});
      }),
  );

  if (!allowWrites) return;

  server.registerTool(
    "cloudkit_deploy_schema",
    {
      title: "CloudKit: Deploy Schema Changes",
      description:
        "Promote the container's DEVELOPMENT schema to PRODUCTION — the API behind the Console's " +
        "Deploy Schema Changes button. **Irreversible and additive-only**: after this you can add " +
        "fields forever but never remove, rename or retype one. Always fetches and returns the " +
        "diff first, and refuses when there is nothing to deploy. Run with dryRun to see the " +
        "diff without committing. Deploy before shipping the build that uses a new field, not " +
        "after: a client cannot alter the Production schema and does not report that it did nothing.",
      inputSchema: z.object({
        containerId: containerArg,
        confirm: confirmArg,
        dryRun: dryRunArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ containerId, dryRun }) =>
      wrap(async () => {
        const id = container(containerId);
        const raw = await client.get(schemaDiffPath(teamId, id));
        const changes = summarizeSchemaDiff(raw);

        if (changes && changes.length === 0) {
          throw new PreconditionError("Nothing to deploy: DEVELOPMENT and PRODUCTION agree.", {
            containerId: id,
          });
        }
        const diff = changes ?? raw;
        if (dryRun) return { dryRun: true, containerId: id, wouldDeploy: diff };

        const schemaUuid = await developmentSchemaUuid(id);
        const result = await client.post(schemaPromotePath(teamId, id, schemaUuid));
        return { deployed: true, containerId: id, schemaUuid, changes: diff, result };
      }),
  );

  server.registerTool(
    "cloudkit_import_schema",
    {
      title: "CloudKit: Import Schema",
      description:
        "Upload a local `.ckdb` file as an environment's schema. Prefer cloudkit_deploy_schema " +
        "for the usual Development-to-Production promotion — this replaces a schema wholesale " +
        "from a file and reports no diff, so what changes is whatever the file says. Validate " +
        "first with cloudkit_validate_schema.",
      inputSchema: z.object({
        environment: environmentArg,
        containerId: containerArg,
        filePath: z.string().min(1).describe('Path to the `.ckdb` file, e.g. "./dev.ckdb".'),
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ environment, containerId, filePath }) =>
      wrap(async () =>
        client.request(
          "POST",
          schemaPath(teamId, container(containerId), environment as CloudKitEnvironment),
          { text: readSchemaFile(filePath) },
        ),
      ),
  );

  /**
   * The UUID `promote` takes. Tried in two places because the container response
   * and the environment schema response are near-identical envelopes and which
   * one carries it is not documented — failing with both paths named beats
   * failing with a 404 on a URL the caller never composed.
   */
  async function developmentSchemaUuid(containerId: string): Promise<string> {
    const fromContainer = developmentSchemaUuidOf(
      await client.get(containerPath(teamId, containerId)),
    );
    if (fromContainer) return fromContainer;

    const fromSchema = developmentSchemaUuidOf(
      await client.get(schemaPath(teamId, containerId, "DEVELOPMENT")),
    );
    if (fromSchema) return fromSchema;

    throw new PreconditionError("Could not find the development schema UUID to promote.", {
      looked: [containerPath(teamId, containerId), schemaPath(teamId, containerId, "DEVELOPMENT")],
      hint: "Inspect those two paths with cloudkit_request to see where the UUID lives.",
    });
  }
};

/**
 * Routes the escape hatch will not carry.
 *
 * `.../environments/{environment}/reset` resets the development schema to match
 * production **and deletes all data in the development environment**. It is not
 * exposed as a tool for that reason, and blocking it here is what makes that
 * decision real: without this, `cloudkit_request` would be a way to reach the
 * one route deliberately left out, which is worse than never having omitted it.
 */
const assertNotDestructive = (path: string): void => {
  if (/\/environments\/[^/]+\/reset\b/.test(path)) {
    throw new PreconditionError(
      "Refusing to call the container reset endpoint: it deletes all data in the " +
        "development environment. Use the CloudKit Console if you genuinely mean to.",
      { path },
    );
  }
};

/** Read a `.ckdb`, naming the resolved path so a wrong relative path is obvious. */
const readSchemaFile = (filePath: string): string => {
  const path = resolve(filePath);
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw new PreconditionError(`Could not read the schema file (${path}).`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
};
