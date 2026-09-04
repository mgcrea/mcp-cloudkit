import type { Logger } from "#/client/auth";

export type QueryValue = string | number | boolean | string[] | undefined;
export type Query = Record<string, QueryValue>;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, 8000);

export const retryAfterMs = (res: Response): number | undefined => {
  const header = res.headers.get("Retry-After");
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(seconds, 0) * 1000 : undefined;
};

export const safeJsonParse = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return text;
  }
};

export const buildQuery = (query: Query | undefined): string => {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

export type RetryPolicy = {
  maxRetries: number;
  /** Prefix for the debug/warn lines, e.g. `GET https://…`. */
  label: string;
  logger?: Logger | undefined;
};

/**
 * Run `perform` until it yields a non-retryable response or the budget runs
 * out. No 401-remint branch: the management token is static, so a 401 means a
 * wrong or revoked credential, and retrying it would only burn the budget for
 * nothing.
 */
export const withRetry = async (
  perform: () => Promise<Response>,
  policy: RetryPolicy,
): Promise<Response> => {
  let attempt = 0;

  for (;;) {
    policy.logger?.debug?.(`[cloudkit] ${policy.label} (attempt ${attempt + 1})`);
    const res = await perform();

    if ((res.status === 429 || res.status >= 500) && attempt < policy.maxRetries) {
      const delay = retryAfterMs(res) ?? backoffMs(attempt);
      policy.logger?.warn?.(`[cloudkit] HTTP ${res.status} — retrying in ${delay}ms`);
      await sleep(delay);
      attempt += 1;
      continue;
    }

    return res;
  }
};
