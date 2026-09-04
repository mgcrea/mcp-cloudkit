import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

const ConfigSchema = z
  .object({
    // Optional at the schema level so "nothing is configured" is a state the
    // server can report, not a crash before it ever connects — see loadConfig.
    managementToken: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    /** Default for the container-scoped tools, so it need not be retyped per call. */
    containerId: z.string().min(1).optional(),
    allowWrites: z.boolean().default(false),
    maxRetries: z.number().int().nonnegative().max(10).default(3),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The on-disk config document. Keys are camelCase to mirror `Config` rather
 * than the env var names: this is a typed JSON file, not a shell.
 *
 * `.strict()` on purpose — a typo'd `teamID` must be an error. Silently
 * ignoring an unknown key looks exactly like "that setting had no effect",
 * which is the worst way to learn your credentials came from somewhere else.
 */
const FileConfigSchema = z
  .object({
    managementToken: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    containerId: z.string().min(1).optional(),
    allowWrites: z.boolean().optional(),
    maxRetries: z.number().int().nonnegative().max(10).optional(),
  })
  .strict();

export type FileConfig = z.infer<typeof FileConfigSchema>;

const parseBool = (value: string | undefined): boolean | undefined => {
  const t = trimmed(value);
  if (t === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(t.toLowerCase());
};

const parseIntOpt = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
};

const trimmed = (value: string | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `readFileSync` does not expand `~`, but it is the natural thing to write in a config file. */
const expandTilde = (path: string): string =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

/**
 * Where the config file lives, most specific first: an explicit override, then
 * the XDG location, then the conventional `~/.config`.
 */
export const resolveConfigPath = (env: NodeJS.ProcessEnv = process.env): string => {
  const explicit = trimmed(env.CLOUDKIT_CONFIG);
  if (explicit) return expandTilde(explicit);
  const base = trimmed(env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  return join(expandTilde(base), "cloudkit", "config.json");
};

/**
 * This file sits next to a management token, so being readable by other users
 * is worth saying out loud. It is a warning and not an error: refusing to
 * start would be a worse trade for someone on a single-user machine.
 */
const warnIfGroupReadable = (path: string): void => {
  if (process.platform === "win32") return; // mode bits mean nothing here
  try {
    if (statSync(path).mode & 0o077) {
      process.stderr.write(
        `[cloudkit] ${path} is readable by other users. Run: chmod 600 ${path}\n`,
      );
    }
  } catch {
    // Not worth failing startup over; the read below reports anything that matters.
  }
};

/**
 * Read the config file, treating "absent" as "contributes nothing". Every
 * other failure throws and names the path, so a malformed file is never
 * mistaken for a missing one — that confusion would send you hunting for
 * credentials that were sitting right there.
 */
const readConfigFile = (path: string): FileConfig => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read the config file (${path}): ${message(err)}`, { cause: err });
  }

  warnIfGroupReadable(path);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`The config file (${path}) is not valid JSON: ${message(err)}`, { cause: err });
  }

  const result = FileConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`The config file (${path}) is not valid: ${issues}`);
  }
  return result.data;
};

/**
 * Environment first, config file second, **per field** — not whole-source. A
 * one-off `CLOUDKIT_ALLOW_WRITES=0` still has to override a file that says
 * `true`. Merging field by field is the only rule that gives both.
 */
export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
  configPath: string = resolveConfigPath(env),
): Config => {
  const file = readConfigFile(configPath);
  return ConfigSchema.parse({
    // Apple's own spelling — `xcrun cktool` reads the same variable — so a
    // shell already set up for cktool configures this server for free, and
    // there is only ever one name for this secret on a machine.
    managementToken: trimmed(env.CLOUDKIT_MANAGEMENT_TOKEN) ?? file.managementToken,
    teamId: trimmed(env.CLOUDKIT_TEAM_ID) ?? file.teamId,
    containerId: trimmed(env.CLOUDKIT_CONTAINER_ID) ?? file.containerId,
    allowWrites: parseBool(env.CLOUDKIT_ALLOW_WRITES) ?? file.allowWrites,
    maxRetries: parseIntOpt(env.CLOUDKIT_MAX_RETRIES) ?? file.maxRetries,
  });
};

/** True once the management token and team id are both present. */
export const isConfigured = (config: Config): boolean =>
  Boolean(config.managementToken && config.teamId);

/**
 * Returned by cloudkit_auth_status and printed to stderr at startup. Prose
 * rather than a code, because this is the text someone acts on when nothing
 * works.
 *
 * The container id is deliberately not required here: it is a per-call
 * argument with an optional default, and `cloudkit_list_containers` is how you
 * discover it in the first place — demanding it up front would gate the one
 * tool that answers it.
 */
export const setupInstructions = (
  config: Config,
  configPath: string = resolveConfigPath(),
): string[] => {
  if (isConfigured(config)) return [];
  const steps: string[] = [];
  if (!config.managementToken) {
    steps.push(
      "Set CLOUDKIT_MANAGEMENT_TOKEN (or add `managementToken` to " +
        `${configPath}). Create one at ` +
        "https://icloud.developer.apple.com/dashboard/account/tokens under " +
        "CloudKit Management Tokens.",
    );
  }
  if (!config.teamId) {
    steps.push(
      "Set CLOUDKIT_TEAM_ID to your 10-character Apple Developer team id, the " +
        "same one in your app's exportOptions.plist.",
    );
  }
  steps.push(
    "A management token can rewrite a container's schema, which is broader " +
      "than reading it. Scope it to the team that needs it and revoke it when " +
      "you are done.",
    "Then restart the server.",
  );
  return steps;
};
