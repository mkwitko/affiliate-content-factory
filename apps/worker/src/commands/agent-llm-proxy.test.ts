import { type AddressInfo, createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startAgentLlmProxy } from "./agent-llm-proxy.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const harness = async (lease: () => Promise<(() => Promise<void>) | null>) => {
  const port = await freePort();
  const ended: string[] = [];
  const upstreamCalls: string[] = [];
  const server = startAgentLlmProxy({
    port,
    host: "127.0.0.1",
    supervisor: {
      lease: async () => {
        const end = await lease();
        return end ? async () => void ended.push("end") : null;
      },
    },
    capability: "copywriting",
    upstream: "http://llama.test",
    token: "secret-token",
    model: "local:qwen3.5-9b",
    fetch: (async (url: string, init: RequestInit) => {
      upstreamCalls.push(`${url} ${String(init.body)}`);
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, init);
  return { server, call, ended, upstreamCalls };
};

const chat = { model: "x", messages: [{ role: "user", content: "hi" }] };
const auth = { authorization: "Bearer secret-token", "content-type": "application/json" };

describe("agent LLM proxy", () => {
  it("refuses requests without the token", async () => {
    const h = await harness(async () => async () => undefined);
    expect((await h.call("/v1/models")).status).toBe(401);
    expect(
      (
        await h.call("/v1/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer nope" },
        })
      ).status,
    ).toBe(401);
    h.server.close();
  });

  it("forwards a chat to the local model inside a GPU lease, and ends the lease", async () => {
    const h = await harness(async () => async () => undefined);
    const response = await h.call("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(chat),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ choices: [{ message: { content: "ok" } }] });
    expect(h.upstreamCalls[0]).toContain("http://llama.test/v1/chat/completions");
    expect(h.ended).toEqual(["end"]);
    expect(await (await h.call("/v1/models", { headers: auth })).json()).toEqual({
      object: "list",
      data: [{ id: "local:qwen3.5-9b", object: "model" }],
    });
    h.server.close();
  });

  it("answers 503 while production holds the GPU, so the agent falls back to the cloud", async () => {
    const h = await harness(async () => null);
    const response = await h.call("/v1/chat/completions", {
      method: "POST",
      headers: auth,
      body: JSON.stringify(chat),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(h.upstreamCalls).toEqual([]);
    h.server.close();
  });
});
