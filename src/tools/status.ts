import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { isConfigured, setupInstructions, type Config } from "#/config";
import { wrap } from "#/tools/util";

/**
 * Registered first and unconditionally, so an unconfigured server is still a
 * useful one — it can say what to set — rather than a connection that closes.
 */
export const registerStatusTool = (server: McpServer, config: Config): void => {
  server.registerTool(
    "cloudkit_auth_status",
    {
      title: "CloudKit: Auth Status",
      description:
        "Report whether this server has a working CloudKit management token, whether writes " +
        "are enabled, and — when something is missing — exactly what to set. Call this first " +
        "when a tool you expected is not listed: an absent tool here means missing " +
        "configuration rather than a bug.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => ({
        configured: isConfigured(config),
        managementToken: config.managementToken ? "set" : null,
        teamId: config.teamId ?? null,
        containerId: config.containerId ?? null,
        writes: config.allowWrites ? "ENABLED" : "disabled",
        setup: setupInstructions(config),
      })),
  );
};
