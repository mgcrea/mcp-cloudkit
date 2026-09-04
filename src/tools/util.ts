import { z } from "zod";

import { CloudKitApiError } from "#/client/errors";

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * Compact, not pretty-printed. `null, 2` adds meaningfully to every response,
 * and no model needs the indentation. Files written to disk for humans stay
 * pretty — see `cloudkit_export_schema`'s `outputPath`.
 */
export const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }],
});

/**
 * Return text as-is. `ok()` JSON-stringifies, which turns a `.ckdb` document
 * into one escaped, unreadable line.
 */
export const okText = (text: string): ToolResult => ({
  content: [{ type: "text", text }],
});

export const fail = (message: string, extra?: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ error: message, ...(extra ? { details: extra } : {}) }),
    },
  ],
  isError: true,
});

/**
 * A local check that failed before anything was sent to CloudKit. Carries the
 * state it read, so the caller sees why rather than just that something was
 * wrong — e.g. which container id was missing, or which two paths were tried
 * looking for a schema UUID.
 */
export class PreconditionError extends Error {
  override readonly name = "PreconditionError";
  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Render a thrown value as a tool error, preserving CloudKit's own detail. */
export const toFailure = (err: unknown): ToolResult => {
  if (err instanceof CloudKitApiError) {
    return fail(err.message, {
      status: err.status,
      serverErrorCode: err.serverErrorCode,
      detail: err.detail,
    });
  }
  if (err instanceof PreconditionError) {
    return fail(err.message, err.details);
  }
  if (err instanceof Error) {
    const details = (err as Error & { details?: unknown }).details;
    return fail(err.message, details);
  }
  return fail("Unknown error", err);
};

/** Run a tool body, JSON-formatting the result and turning errors into a tool error. */
export const wrap = async <T>(fn: () => Promise<T>): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (err) {
    return toFailure(err);
  }
};

/** Like `wrap`, but the body chooses its own result shape (e.g. raw `.ckdb` text). */
export const wrapResult = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    return toFailure(err);
  }
};

/** Destructive tools require this, so an agent can never mutate something in passing. */
export const confirmArg = z
  .literal(true)
  .describe("Must be true. Explicit acknowledgement that this changes the CloudKit schema.");

/**
 * Opt-in preflight. Defaults to false, so adding it never turns an existing
 * call into a no-op.
 */
export const dryRunArg = z
  .boolean()
  .default(false)
  .describe("Stop before the irreversible step and report what would happen. Defaults to false.");
