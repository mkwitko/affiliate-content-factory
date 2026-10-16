import { createHash } from "node:crypto";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { HomeTaskDeps } from "@money-maker/core/home-worker/tasks";
import type {
  HomeWorkerToken,
  HomeWorkerTokenRepository,
} from "@money-maker/core/home-worker/tokens";
import { describe, expect, it, vi } from "vitest";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const jobId = "33333333-3333-4333-8333-333333333333";
const leaseToken = "44444444-4444-4444-8444-444444444444";
const plain = `mmhw_${"a".repeat(43)}`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const createFixture = (options: { revoked?: boolean } = {}) => {
  const stored: HomeWorkerToken[] = [
    {
      id: "55555555-5555-4555-8555-555555555555",
      workspaceId,
      name: "desktop",
      tokenHash: sha256(plain),
      prefix: plain.slice(0, 12),
      capabilities: ["visual_qa"],
      createdById: userId,
      createdAt: new Date("2026-09-30T10:00:00Z"),
      lastUsedAt: null,
      revokedAt: options.revoked ? new Date("2026-09-30T11:00:00Z") : null,
    },
  ];
  const tokens: HomeWorkerTokenRepository = {
    create: vi.fn(async (token: HomeWorkerToken) => {
      stored.push(token);
      return token;
    }),
    findByHash: async (hash: string) => stored.find((token) => token.tokenHash === hash) ?? null,
    listForWorkspace: async () => stored,
    revoke: async () => null,
    touch: async () => undefined,
    recordHeartbeat: vi.fn(async () => undefined),
  };
  const queue = {
    claim: vi.fn(async () => null),
    complete: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    failPermanently: vi.fn(async () => undefined),
    takeLease: vi.fn(async (input: { id: string; leaseToken: string }) =>
      input.id === jobId && input.leaseToken === leaseToken
        ? {
            id: jobId,
            workspaceId,
            name: "review_frames",
            payload: { version: 1 as const, workspaceId, identifiers: {} },
            leaseToken,
            idempotencyKey: "review-frames:r",
            attemptCount: 1,
          }
        : null,
    ),
  };
  const dependencies = {
    invitation: {} as ApiDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({
        workspaceId,
        userId,
        role: "owner" as const,
        status: "active" as const,
      }),
      addMembership: async () => undefined,
    },
    continuityRepository: { listForSeries: async () => [], record: async () => undefined },
    homeWorker: { tokens, tasks: { queue } as unknown as HomeTaskDeps },
    authenticate: async () => ({
      userId,
      verifiedEmail: "owner@example.com",
      scopes: new Set(["workspace:read", "workspace:write", "content:read", "content:write"]),
    }),
  } as unknown as ApiDependencies;
  return { dependencies, queue, tokens };
};

const callTool = (name: string, args: Record<string, unknown>) => ({
  method: "POST" as const,
  url: "/mcp",
  headers: { accept: "application/json, text/event-stream" },
  payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
});

describe("home worker routes (ADR 0012)", () => {
  it("rejects a missing, malformed or revoked token before reading the queue", async () => {
    for (const [fixture, header] of [
      [createFixture(), undefined],
      [createFixture(), "Bearer not-a-home-token"],
      [createFixture({ revoked: true }), `Bearer ${plain}`],
    ] as const) {
      const app = buildApp(fixture.dependencies);
      const response = await app.inject({
        method: "POST",
        url: "/v1/home-worker/claim",
        ...(header ? { headers: { authorization: header } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(fixture.queue.claim).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("stores heartbeats for owned capabilities only and rejects unknown fields or oversize", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const headers = { authorization: `Bearer ${plain}` };
    const url = "/v1/home-worker/heartbeat";
    const base = {
      capabilities: ["visual_qa", "image_generation"],
      busy: "image_generation",
      runtimes: { visual_qa: "healthy", image_generation: "starting" },
      lastCompletedAt: "2026-10-02T10:00:00.000Z",
      lastFailureCode: "runtime_unhealthy",
    };
    expect((await app.inject({ method: "POST", url, payload: base })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url, headers, payload: base });
    expect(ok.statusCode).toBe(204);
    expect(fixture.tokens.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        heartbeat: expect.objectContaining({
          capabilities: ["visual_qa"],
          busy: null,
          runtimes: { visual_qa: "healthy" },
        }),
      }),
    );
    for (const payload of [
      { ...base, command: ["llama-server"] },
      { ...base, lastFailureCode: "Bad Code!" },
      { ...base, runtimes: { other: "healthy" } },
    ])
      expect((await app.inject({ method: "POST", url, headers, payload })).statusCode).toBe(400);
    const big = await app.inject({
      method: "POST",
      url,
      headers,
      payload: { ...base, pad: "x".repeat(3000) },
    });
    expect(big.statusCode).toBe(413);
    await app.close();
  });

  it("claims only the token's workspace and answers 204 when nothing is queued", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      url: "/v1/home-worker/claim",
      headers: { authorization: `Bearer ${plain}` },
    });
    expect(response.statusCode).toBe(204);
    expect(fixture.queue.claim).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, names: ["review_frames", "check_scene_fidelity"] }),
    );
    const preferred = await app.inject({
      method: "POST",
      url: "/v1/home-worker/claim",
      headers: { authorization: `Bearer ${plain}` },
      payload: { loaded: "visual_qa" },
    });
    expect(preferred.statusCode).toBe(204);
    expect(fixture.queue.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferNames: ["review_frames", "check_scene_fidelity"] }),
    );
    await app.close();
  });

  it("validates results and hides tasks it did not lease", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const headers = { authorization: `Bearer ${plain}` };
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: { leaseToken, result: { kind: "review_frames", review: { findings: "x" } } },
    });
    expect(invalid.statusCode).toBe(400);
    const badVersion = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: {
        leaseToken,
        workerVersion: "v1; rm -rf",
        result: { kind: "review_frames", review: { record: { vlm: "skipped" }, findings: [] } },
      },
    });
    expect(badVersion.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: {
        leaseToken: "66666666-6666-4666-8666-666666666666",
        result: { kind: "review_frames", review: { record: { vlm: "skipped" }, findings: [] } },
      },
    });
    expect(unknown.statusCode).toBe(404);
    const mismatch = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: { leaseToken, result: { kind: "direct_scenes", scenes: [] } },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(fixture.queue.complete).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects copy drafts with extra fields or the wrong slide count", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const slide = (index: number) => ({
      index,
      total: 6,
      template: "benefit",
      headline: "h",
      claims: [],
    });
    const slides = Array.from({ length: 6 }, (_, i) => slide(i + 1));
    const post = (draft: unknown) =>
      app.inject({
        method: "POST",
        url: `/v1/home-worker/tasks/${jobId}/result`,
        headers: { authorization: `Bearer ${plain}` },
        payload: { leaseToken, result: { kind: "draft_offer_copy", model: "m", draft } },
      });
    expect((await post({ slides, captions: { threads: "x" }, extra: 1 })).statusCode).toBe(400);
    expect((await post({ slides: slides.slice(0, 2), captions: {} })).statusCode).toBe(400);
    // Three to six slides are a valid deck (copy-formats beatsFor); a voice line rides along.
    expect(
      (
        await post({
          slides: slides.slice(0, 5).map((s) => ({ ...s, total: 5, voiceLine: "fala" })),
          captions: {},
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await post({ slides: [{ ...slide(1), voiceLine: "x".repeat(141) }], captions: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post({ slides: [...slides.slice(1), { ...slide(6), url: "x" }], captions: {} }))
        .statusCode,
    ).toBe(400);
    const hook = { headline: "Gancho", captionFirstLine: "Abre a legenda." };
    expect(
      (await post({ slides, captions: {}, hookOptions: Array(5).fill(hook) })).statusCode,
    ).toBe(400);
    expect(
      (await post({ slides, captions: {}, hookOptions: [{ ...hook, url: "x" }] })).statusCode,
    ).toBe(400);
    // Shape accepted; this fixture's leased job is not a copy job, so the result is refused later.
    expect((await post({ slides, captions: {}, hookOptions: [hook] })).statusCode).toBe(422);
    await app.close();
  });

  it("refuses plate-sized bodies and fake deterministic findings from a review-only token", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const headers = { authorization: `Bearer ${plain}` };
    const large = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: { leaseToken, result: { kind: "direct_scenes", scenes: "x".repeat(2_000_000) } },
    });
    expect(large.statusCode).toBe(413);
    const planted = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: {
        leaseToken,
        result: {
          kind: "review_frames",
          review: {
            record: { vlm: "reviewed" },
            findings: [{ id: "caption_contrast", severity: "WARN", sceneIndex: 1 }],
          },
        },
      },
    });
    expect(planted.statusCode).toBe(400);
    expect(fixture.queue.takeLease).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuses clip-sized bodies from a token without video_generation and unknown clip fields", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const headers = { authorization: `Bearer ${plain}` };
    const clip = { kind: "generate_clips", sceneIndex: 1, model: "m", mimeType: "video/webm" };
    const large = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/result`,
      headers,
      payload: { leaseToken, result: { ...clip, base64: "A".repeat(2_000_000) } },
    });
    expect(large.statusCode).toBe(413);
    for (const bad of [
      { ...clip, base64: "AQID", mimeType: "video/x-msvideo" },
      { ...clip, base64: "AQID", extra: true },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/home-worker/tasks/${jobId}/result`,
        headers,
        payload: { leaseToken, result: bad },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(fixture.queue.takeLease).not.toHaveBeenCalled();
    await app.close();
  });

  it("bounds offer scene and fidelity results by schema and capability", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const post = (result: unknown) =>
      app.inject({
        method: "POST",
        url: `/v1/home-worker/tasks/${jobId}/result`,
        headers: { authorization: `Bearer ${plain}` },
        payload: { leaseToken, result },
      });
    const scene = { key: "1:feed", base64: "AQID", model: "local:flux-2-klein-4b", seed: 1 };
    // A visual_qa-only token may not send image-sized bodies.
    expect(
      (
        await post({
          kind: "generate_offer_scenes",
          scenes: [{ ...scene, base64: "A".repeat(2_000_000) }],
        })
      ).statusCode,
    ).toBe(413);
    for (const bad of [
      { kind: "generate_offer_scenes", scenes: [{ ...scene, key: "../x" }] },
      { kind: "generate_offer_scenes", scenes: [{ ...scene, extra: true }] },
      { kind: "generate_offer_scenes", scenes: Array.from({ length: 4 }, () => scene) },
      { kind: "generate_offer_scenes", scenes: [{ ...scene, depthBase64: "" }] },
      { kind: "check_scene_fidelity", answer: {}, model: "m", extra: true },
      { kind: "check_narration", transcript: "x".repeat(6_001), model: "m" },
      { kind: "check_narration", transcript: "ok", model: "" },
      { kind: "check_narration", transcript: "ok", model: "m", extra: true },
      { kind: "check_narration", transcript: 42, model: "m" },
    ])
      expect((await post(bad)).statusCode).toBe(400);
    expect(fixture.queue.takeLease).not.toHaveBeenCalled();
    // A well-formed answer reaches core, which refuses it for the review_frames lease.
    const answered = await post({ kind: "check_scene_fidelity", answer: { x: 1 }, model: "m" });
    expect(answered.statusCode).toBe(422);
    // A well-formed transcript passes the schema; core refuses it for the review_frames lease.
    const heard = await post({ kind: "check_narration", transcript: "ola", model: "m" });
    expect(heard.statusCode).toBe(422);
    await app.close();
  });

  it("returns a failed task to the queue with a sanitized reason", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const response = await app.inject({
      method: "POST",
      url: `/v1/home-worker/tasks/${jobId}/fail`,
      headers: { authorization: `Bearer ${plain}` },
      payload: { leaseToken, reason: "GPU out of memory!", retryable: true },
    });
    expect(response.statusCode).toBe(200);
    expect(fixture.queue.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: jobId, reason: "home:GPU_out_of_memory_" }),
    );
    await app.close();
  });

  it("issues a token once over MCP and stores only its hash", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    const response = await app.inject(
      callTool("create_home_worker_token", {
        workspaceId,
        name: "mac",
        capabilities: ["scene_director"],
      }),
    );
    const result = response.json().result.structuredContent as { plainToken: string };
    expect(result.plainToken).toMatch(/^mmhw_/);
    const created = vi.mocked(fixture.tokens.create).mock.calls[0]?.[0];
    expect(created?.tokenHash).toBe(sha256(result.plainToken));
    expect(JSON.stringify(created)).not.toContain(result.plainToken);
    await app.close();
  });

  it("reaches the continuity repository from the HTTP MCP route", async () => {
    const app = buildApp(createFixture().dependencies);
    const response = await app.inject(
      callTool("list_continuity_facts", { workspaceId, seriesId: "s1", castIds: ["carla"] }),
    );
    expect(response.json().result.structuredContent).toEqual({ facts: [] });
    await app.close();
  });
});
