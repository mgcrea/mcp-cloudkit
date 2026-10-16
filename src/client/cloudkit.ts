import type { Logger } from "#/client/auth";
import { CloudKitApiError } from "#/client/errors";
import { buildQuery, safeJsonParse, withRetry, type Query } from "#/client/http";

export type CloudKitEnvironment = "DEVELOPMENT" | "PRODUCTION";

export type CloudKitClientOptions = {
  baseUrl?: string;
  /** The management token, verbatim — see the note in client/auth.ts. */
  token: string;
  maxRetries?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  userAgent?: string;
};

export type CloudKitRequestOptions = {
  query?: Query;
  body?: unknown;
  /**
   * A `.ckdb` upload, sent the way cktool sends one: a multipart body with a
   * single part named `file`. A `text/plain` body is refused with 415.
   */
  file?: { name: string; content: string };
  accept?: string;
};

const DEFAULT_BASE_URL = "https://api.icloud.apple.com";

/**
 * Pull a human-readable reason out of whatever CloudKit answered with.
 *
 * Tolerant on purpose: this API is undocumented, so the envelope is not
 * something to assume. A parsed `reason` is the common case; anything else is
 * surfaced as raw text rather than swallowed, because an unrecognised error
 * body is exactly when you most need to see it.
 */
const describeError = (status: number, parsed: unknown, raw: string): string => {
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const reason = obj.reason ?? obj.message ?? obj.detail;
    if (typeof reason === "string" && reason) return reason;
  }
  return raw ? raw.slice(0, 500) : `CloudKit request failed with HTTP ${status}`;
};

const serverErrorCodeOf = (parsed: unknown): string | undefined => {
  if (parsed && typeof parsed === "object") {
    const code = (parsed as Record<string, unknown>).serverErrorCode;
    if (typeof code === "string") return code;
  }
  return undefined;
};

/**
 * Minimal fetch client for the CloudKit **management** API — the service behind
 * the CloudKit Console and `xcrun cktool`, not CloudKit Web Services.
 *
 * Undocumented by Apple. Every route here was read out of the `cktool` binary
 * shipped in Xcode (`strings $(xcrun -f cktool)`), which is a thin client over
 * exactly these endpoints. That is why the tools built on this stay close to
 * what cktool itself does, and why `cloudkit_request` exists as an escape hatch.
 */
export class CloudKitClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly userAgent: string;

  constructor(opts: CloudKitClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.token = opts.token;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetch ?? fetch;
    this.logger = opts.logger;
    this.userAgent = opts.userAgent ?? "mcp-cloudkit-js";
  }

  private async send(
    method: string,
    path: string,
    opts: CloudKitRequestOptions,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const hasJson = opts.body !== undefined;
    // Built per attempt: a FormData body is consumed by the request that sends it.
    const form = (): FormData | undefined => {
      if (!opts.file) return undefined;
      const data = new FormData();
      data.append(
        "file",
        new Blob([opts.file.content], { type: "application/octet-stream" }),
        opts.file.name,
      );
      return data;
    };

    return withRetry(
      () =>
        this.fetchImpl(url, {
          method,
          // X-ACP-API-TOKEN is what cktool sends a management token in, read off
          // a live session under a debugger — the name never appears in the
          // binary's `strings`. X-Apple-CloudKit-User-Token, which does, is for
          // *user* tokens: a management token sent there gets 401 "Failed to
          // validate user token". X-CK-CLIENT is not checked; cktool sends its
          // own name and version, so this sends ours.
          headers: {
            Accept: opts.accept ?? "application/json",
            "X-ACP-API-TOKEN": this.token,
            "X-CK-CLIENT": this.userAgent,
            "User-Agent": this.userAgent,
            // No Content-Type for a file: fetch writes the multipart one,
            // boundary included, from the FormData body.
            ...(hasJson ? { "Content-Type": "application/json" } : {}),
          },
          ...(hasJson ? { body: JSON.stringify(opts.body) } : {}),
          ...(opts.file ? { body: form() } : {}),
        }),
      { maxRetries: this.maxRetries, label: `${method} ${url}`, logger: this.logger },
    );
  }

  /** Issue a request and parse the JSON body, throwing `CloudKitApiError` on failure. */
  async request<T = unknown>(
    method: string,
    path: string,
    opts: CloudKitRequestOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, opts);
    const raw = await res.text();
    const parsed = safeJsonParse(raw);

    if (!res.ok) {
      throw new CloudKitApiError(describeError(res.status, parsed, raw), {
        status: res.status,
        serverErrorCode: serverErrorCodeOf(parsed),
        detail: parsed,
      });
    }
    return parsed as T;
  }

  /**
   * Issue a request and return the body as text.
   *
   * `schema/export` answers with a `.ckdb` document, not JSON — running that
   * through `request` would hand back a string that had been through
   * `safeJsonParse` for no reason and lose the distinction between "not JSON"
   * and "JSON that happens to be a string".
   */
  async requestText(
    method: string,
    path: string,
    opts: CloudKitRequestOptions = {},
  ): Promise<string> {
    const res = await this.send(method, path, { accept: "text/plain", ...opts });
    const raw = await res.text();

    if (!res.ok) {
      const parsed = safeJsonParse(raw);
      throw new CloudKitApiError(describeError(res.status, parsed, raw), {
        status: res.status,
        serverErrorCode: serverErrorCodeOf(parsed),
        detail: parsed,
      });
    }
    return raw;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, query ? { query } : {});
  }

  post<T = unknown>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, {
      ...(body !== undefined ? { body } : {}),
      ...(query ? { query } : {}),
    });
  }
}

// --- Route builders --------------------------------------------------------
//
// Spelled out rather than interpolated at each call site: the paths are long,
// nearly identical, and the difference that matters — team-scoped vs
// environment-scoped — is invisible in a template literal three lines wide.
//
// Only routes a management token can reach are built here. The binary also
// names `…/recordTypes`, `…/containers/{id}` and `…/schema/diff`; they exist,
// but answer a management token with 401 "authentication-failed" — they are
// the Console's, behind a signed-in session. cktool never calls them either.

/** Containers visible to a team. The one route that is not under `/v1/database`. */
export const containersPath = (teamId: string): string =>
  `/teams/${encodeURIComponent(teamId)}/containers`;

const containerPath = (teamId: string, containerId: string): string =>
  `/v1/database/teams/${encodeURIComponent(teamId)}/containers/${encodeURIComponent(containerId)}`;

const environmentPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${containerPath(teamId, containerId)}/environments/${environment}`;

/** The environment's schema as a `.ckdb` document. */
export const schemaExportPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${environmentPath(teamId, containerId, environment)}/schema/export`;

/**
 * GET reads the schema record — its `uuid`, the `.ckdb` as `textSchema`, and
 * every record type and field — so it carries what the Console-only routes
 * would. PUT imports a `.ckdb` (cktool's own method; not POST).
 */
export const schemaPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${environmentPath(teamId, containerId, environment)}/schema`;

export const schemaValidatePath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${schemaPath(teamId, containerId, environment)}/validate`;

/**
 * Deploy: promote a schema UUID to Production. Irreversible and additive-only.
 * Not yet seen to accept a management token — see cloudkit_deploy_schema.
 */
export const schemaPromotePath = (
  teamId: string,
  containerId: string,
  schemaUuid: string,
): string =>
  `${containerPath(teamId, containerId)}/schema/${encodeURIComponent(schemaUuid)}/promote`;
