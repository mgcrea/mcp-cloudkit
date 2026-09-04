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
  /** Sent verbatim as the request body, for the `.ckdb` schema uploads. */
  text?: string;
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
    const hasText = opts.text !== undefined;

    return withRetry(
      () =>
        this.fetchImpl(url, {
          method,
          headers: {
            Accept: opts.accept ?? "application/json",
            "X-Apple-CloudKit-User-Token": this.token,
            "User-Agent": this.userAgent,
            ...(hasJson ? { "Content-Type": "application/json" } : {}),
            ...(hasText ? { "Content-Type": "text/plain" } : {}),
          },
          ...(hasJson ? { body: JSON.stringify(opts.body) } : {}),
          ...(hasText ? { body: opts.text } : {}),
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

/** Containers visible to a team. */
export const containersPath = (teamId: string): string =>
  `/v1/database/teams/${encodeURIComponent(teamId)}/containers`;

/** One container, which is where the schema UUIDs live. */
export const containerPath = (teamId: string, containerId: string): string =>
  `${containersPath(teamId)}/${encodeURIComponent(containerId)}`;

const environmentPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${containerPath(teamId, containerId)}/environments/${environment}`;

export const recordTypesPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${environmentPath(teamId, containerId, environment)}/recordTypes`;

export const recordTypePath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
  recordType: string,
): string =>
  `${recordTypesPath(teamId, containerId, environment)}/${encodeURIComponent(recordType)}`;

export const recordTypeFieldsPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
  recordType: string,
): string => `${recordTypePath(teamId, containerId, environment, recordType)}/fields`;

/** The environment's schema as a `.ckdb` document. */
export const schemaExportPath = (
  teamId: string,
  containerId: string,
  environment: CloudKitEnvironment,
): string => `${environmentPath(teamId, containerId, environment)}/schema/export`;

/** GET reads the schema record (and its UUID); POST imports a `.ckdb`. */
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

/** Development against Production — what the Console shows before deploying. */
export const schemaDiffPath = (teamId: string, containerId: string): string =>
  `${containerPath(teamId, containerId)}/schema/diff`;

/** Deploy: promote a schema UUID to Production. Irreversible and additive-only. */
export const schemaPromotePath = (
  teamId: string,
  containerId: string,
  schemaUuid: string,
): string =>
  `${containerPath(teamId, containerId)}/schema/${encodeURIComponent(schemaUuid)}/promote`;
