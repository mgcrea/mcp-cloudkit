import type { McpServer } from "@modelcontextprotocol/server";

import type { CloudKitClient } from "#/client/cloudkit";
import { isConfigured, type Config } from "#/config";
import { registerCloudKitTools } from "#/tools/cloudkit";
import { registerStatusTool } from "#/tools/status";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see CLOUDKIT_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * Register the tools. Read tools are always registered once the server is
 * configured; write tools are only registered when `allowWrites` is set, so
 * with the flag off they are not merely refused — they are invisible, and
 * cannot be called at all.
 */
export const registerTools = (
  server: McpServer,
  client: CloudKitClient,
  ctx: ToolContext,
): void => {
  const { config, allowWrites } = ctx;

  // Registered first and unconditionally, so an unconfigured server is still a
  // useful one — it can say what to set — rather than a connection that closes.
  registerStatusTool(server, config);
  if (!isConfigured(config) || !config.teamId) return;

  registerCloudKitTools(server, client, {
    teamId: config.teamId,
    defaultContainerId: config.containerId,
    allowWrites,
  });
};
