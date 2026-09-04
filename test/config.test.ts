import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isConfigured, loadConfig, setupInstructions } from "#/config";
import { ABSENT_CONFIG } from "#test/helpers";

const tmp = (): string => mkdtempSync(join(tmpdir(), "cloudkit-"));

/** Write a config file and return its path. */
const configFile = (contents: unknown, mode = 0o600): string => {
  const path = join(tmp(), "config.json");
  writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  chmodSync(path, mode);
  return path;
};

describe("configuration", () => {
  it("is unconfigured, not broken, when nothing is set", () => {
    const config = loadConfig({}, ABSENT_CONFIG);
    expect(isConfigured(config)).toBe(false);
    expect(config.allowWrites).toBe(false);
  });

  it("reads the management credentials from the environment", () => {
    const config = loadConfig(
      {
        CLOUDKIT_MANAGEMENT_TOKEN: "token-from-env",
        CLOUDKIT_TEAM_ID: "75QE9PRT3V",
        CLOUDKIT_CONTAINER_ID: "iCloud.io.mgcrea.Balise",
      },
      ABSENT_CONFIG,
    );
    expect(config.managementToken).toBe("token-from-env");
    expect(config.teamId).toBe("75QE9PRT3V");
    expect(config.containerId).toBe("iCloud.io.mgcrea.Balise");
    expect(isConfigured(config)).toBe(true);
  });

  it("reads them from the config file too", () => {
    const path = configFile({ managementToken: "token-from-file", teamId: "TEAMFROMFILE" });
    const config = loadConfig({}, path);
    expect(config.managementToken).toBe("token-from-file");
    expect(config.teamId).toBe("TEAMFROMFILE");
  });

  it("lets the environment win per field", () => {
    const path = configFile({ managementToken: "token-from-file", teamId: "TEAMFROMFILE" });
    const config = loadConfig({ CLOUDKIT_TEAM_ID: "TEAMFROMENV" }, path);
    expect(config.teamId).toBe("TEAMFROMENV");
    // Untouched by the override, rather than dropped with the rest of the file.
    expect(config.managementToken).toBe("token-from-file");
  });

  it("needs a team id as well as a token", () => {
    const config = loadConfig({ CLOUDKIT_MANAGEMENT_TOKEN: "t" }, ABSENT_CONFIG);
    expect(isConfigured(config)).toBe(false);
    expect(setupInstructions(config).join(" ")).toContain("CLOUDKIT_TEAM_ID");
  });

  it("does not require a container id, which is what list_containers is for", () => {
    const config = loadConfig(
      { CLOUDKIT_MANAGEMENT_TOKEN: "t", CLOUDKIT_TEAM_ID: "T" },
      ABSENT_CONFIG,
    );
    expect(isConfigured(config)).toBe(true);
    expect(config.containerId).toBeUndefined();
  });

  it("says nothing to set once it is configured", () => {
    const config = loadConfig(
      { CLOUDKIT_MANAGEMENT_TOKEN: "t", CLOUDKIT_TEAM_ID: "T" },
      ABSENT_CONFIG,
    );
    expect(setupInstructions(config)).toEqual([]);
  });

  it("rejects a typo'd key in the config file rather than ignoring it", () => {
    const path = configFile({ teamID: "TEAM" });
    expect(() => loadConfig({}, path)).toThrow(/teamID|not valid/);
  });

  it("reports a malformed JSON file with its path, not as absent", () => {
    const path = configFile("{not json", 0o600);
    expect(() => loadConfig({}, path)).toThrow(/not valid JSON/);
  });

  it("reads CLOUDKIT_ALLOW_WRITES as a boolean, env over file", () => {
    const path = configFile({
      managementToken: "t",
      teamId: "T",
      allowWrites: true,
    });
    expect(loadConfig({}, path).allowWrites).toBe(true);
    expect(loadConfig({ CLOUDKIT_ALLOW_WRITES: "0" }, path).allowWrites).toBe(false);
  });
});
