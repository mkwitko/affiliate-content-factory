import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { HomeCapability } from "@money-maker/core/home-worker/tokens";
import type { RuntimeSupervisor } from "./home-runtime.js";

/**
 * The desktop's LLM for the VM's agents (spec 2026-10-14, plan D): an OpenAI-compatible endpoint
 * reached only over a private network, in front of the copy model's llama-server. Production keeps the
 * GPU: a request waits up to `waitMs` while a task holds another model, then gets 503 so the
 * agent falls back to the free cloud (owner decision 2026-10-14). Bearer token required.
 */
export type AgentLlmProxyOptions = Readonly<{
  supervisor: Pick<RuntimeSupervisor, "lease">;
  /** The capability whose runtime serves chat (the copy model). */
  capability: HomeCapability;
  /** llama-server origin, e.g. http://127.0.0.1:18081 */
  upstream: string;
  token: string;
  model: string;
  waitMs?: number;
  timeoutMs?: number;
  maxBodyBytes?: number;
  fetch?: typeof fetch;
  log?: (event: string, fields: Readonly<Record<string, string | number>>) => void;
}>;

const sameToken = (given: string | undefined, expected: string): boolean => {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

const send = (res: ServerResponse, status: number, body: unknown, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

export const agentLlmHandler = (options: AgentLlmProxyOptions) => {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!sameToken(req.headers.authorization, options.token))
      return send(res, 401, { error: { message: "unauthorized" } });
    if (req.method === "GET" && req.url === "/v1/models")
      return send(res, 200, { object: "list", data: [{ id: options.model, object: "model" }] });
    if (req.method !== "POST" || req.url !== "/v1/chat/completions")
      return send(res, 404, { error: { message: "not_found" } });
    const body = await readBody(req, options.maxBodyBytes ?? 4_000_000);
    if (!body) return send(res, 413, { error: { message: "too_large" } });
    const end = await options.supervisor.lease(options.capability, options.waitMs ?? 30_000);
    if (!end) {
      log("agent_llm_busy", { capability: options.capability });
      return send(res, 503, { error: { message: "desktop_busy" } }, { "retry-after": "60" });
    }
    const started = Date.now();
    try {
      const upstream = await doFetch(`${options.upstream}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 300_000),
      });
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
      log("agent_llm_done", { status: upstream.status, ms: Date.now() - started });
    } catch (error) {
      log("agent_llm_failed", { reason: error instanceof Error ? error.name : "unknown" });
      if (!res.headersSent) send(res, 502, { error: { message: "upstream_failed" } });
      else res.end();
    } finally {
      await end();
    }
  };
};

export const startAgentLlmProxy = (
  options: AgentLlmProxyOptions & Readonly<{ port: number; host?: string }>,
): Server => {
  const handler = agentLlmHandler(options);
  const server = createServer((req, res) => void handler(req, res));
  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
};
