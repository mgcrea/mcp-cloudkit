import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { vi } from "vitest";

import { loadConfig, type Config } from "#/config";
import { createServer } from "#/server";

/**
 * A config path that cannot exist, so every test that does not pass its own
 * `configPath` still gets an empty file rather than the developer's real
 * ~/.config/cloudkit/config.json. Without this the suite passes on the machine
 * that has credentials configured and fails in CI, or the reverse.
 */
export const ABSENT_CONFIG = "/nonexistent/cloudkit/config.json";

export const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });

export const textResponse = (body: string, init: { status?: number } = {}): Response =>
  new Response(body, { status: init.status ?? 200, headers: { "content-type": "text/plain" } });

const READ_ONLY_ENV = { CLOUDKIT_MANAGEMENT_TOKEN: "test-token", CLOUDKIT_TEAM_ID: "75QE9PRT3V" };

export const connect = async (
  env: Record<string, string> = {},
  fetchImpl?: ReturnType<typeof vi.fn>,
) => {
  const config: Config = loadConfig(env, ABSENT_CONFIG);
  const fetchMock = fetchImpl ?? vi.fn(async () => jsonResponse({}));
  const { server } = createServer({ config, fetch: fetchMock as unknown as typeof fetch });

  // Both halves of a linked pair must come from the SAME package: v2 exports
  // InMemoryTransport from both /client and /server, and the two copies keep
  // private state that does not cross. Mixing them makes the pair hang rather
  // than fail, which is a miserable thing to debug.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    config,
    callCount: (): number => fetchMock.mock.calls.length,
    urlAt: (index = 0): string => String(fetchMock.mock.calls[index]?.[0]),
    initAt: (index = 0): RequestInit => (fetchMock.mock.calls[index]?.[1] ?? {}) as RequestInit,
    toolNames: async (): Promise<string[]> =>
      (await client.listTools()).tools.map((t) => t.name).toSorted(),
    tool: async (name: string) => (await client.listTools()).tools.find((t) => t.name === name),
    call: async (name: string, args: Record<string, unknown> = {}) => {
      // A schema violation is rejected by the SDK at the protocol layer and
      // never reaches the tool body — which is the behaviour we want, so the
      // harness reports it as an error rather than failing to parse it.
      let res;
      try {
        res = await client.callTool({ name, arguments: args });
      } catch (err) {
        return { isToolError: true, rejected: true, error: String(err) } as Record<string, unknown>;
      }
      const text = (res.content as { type: string; text: string }[])[0]?.text ?? "{}";
      try {
        return { ...JSON.parse(text), isToolError: res.isError === true } as Record<
          string,
          unknown
        >;
      } catch {
        return { isToolError: res.isError === true, text } as Record<string, unknown>;
      }
    },
    /** Raw text of the first content block — for cloudkit_export_schema. */
    text: async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const res = await client.callTool({ name, arguments: args });
      return (res.content as { type: string; text: string }[])[0]?.text ?? "";
    },
  };
};

/** A fully configured, read-only connection. */
export const connectConfigured = (
  env: Record<string, string> = {},
  fetchImpl?: ReturnType<typeof vi.fn>,
) => connect({ ...READ_ONLY_ENV, ...env }, fetchImpl);

/** A fully configured connection with writes enabled. */
export const connectWithWrites = (
  env: Record<string, string> = {},
  fetchImpl?: ReturnType<typeof vi.fn>,
) => connect({ ...READ_ONLY_ENV, CLOUDKIT_ALLOW_WRITES: "1", ...env }, fetchImpl);
