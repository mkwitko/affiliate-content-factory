import { createHash } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "./asset.js";
import { createStageCache, STAGE_ARTIFACT_ROLE, stageCacheKey } from "./stage-cache.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const otherWorkspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const stored = (overrides: Partial<Asset> = {}): Asset => ({
  id: "cached-1",
  workspaceId,
  objectKey: `workspaces/${workspaceId}/assets/cached-1`,
  checksum: sha(bytes),
  mimeType: "audio/wav",
  width: 0,
  height: 0,
  provenance: "generated",
  commercialUse: null,
  license: "internal",
  state: "active",
  metadata: {
    role: STAGE_ARTIFACT_ROLE,
    stage: "tts",
    cacheKey: stageCacheKey({ stage: "tts", version: "v1", inputs: { text: "oi" } }),
    version: "v1",
    durationMs: 900,
    words: [{ text: "oi", startMs: 0, endMs: 900 }],
    usageCount: 1,
    lastUsedAt: "2026-09-30T00:00:00.000Z",
  },
  ...overrides,
});

const deps = (assets: readonly Asset[] = [], fetched: Uint8Array = bytes) => {
  const listByMetadata = vi.fn(async (input: { workspaceId: string; value: string }) =>
    assets.filter(
      (a) => a.workspaceId === input.workspaceId && a.metadata?.["cacheKey"] === input.value,
    ),
  );
  return {
    assets: {
      listByMetadata,
      create: vi.fn(async (a: Asset) => a),
      updateState: vi.fn(async () => null),
      updateMetadata: vi.fn(async () => null),
    },
    store: {
      putObject: vi.fn(async () => undefined),
      createDownload: vi.fn(async () => ({ method: "GET" as const, url: "https://r2.test/x" })),
    },
    fetchBytes: vi.fn(async () => fetched),
    now: () => new Date("2026-09-30T12:00:00.000Z"),
  };
};

const produce = vi.fn(async () => ({
  bytes,
  mimeType: "audio/wav",
  metadata: { durationMs: 900, words: [{ text: "oi", startMs: 0, endMs: 900 }] },
}));

describe("stageCacheKey", () => {
  it("is stable across key order and changes with version", () => {
    const a = stageCacheKey({ stage: "tts", version: "v1", inputs: { text: "oi", voiceId: "pf" } });
    const b = stageCacheKey({ stage: "tts", version: "v1", inputs: { voiceId: "pf", text: "oi" } });
    const c = stageCacheKey({ stage: "tts", version: "v2", inputs: { text: "oi", voiceId: "pf" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createStageCache", () => {
  it("produces, stores and marks the asset active on a miss", async () => {
    const d = deps();
    const cache = createStageCache(d);
    const result = await cache.getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(false);
    expect(result.bytes).toBe(bytes);
    expect(d.assets.create).toHaveBeenCalledOnce();
    const created = d.assets.create.mock.calls[0]?.[0] as Asset;
    expect(created.mimeType).toBe("audio/wav");
    expect(created.checksum).toBe(sha(bytes));
    expect(created.byteSize).toBe(bytes.byteLength);
    expect(created.metadata).toMatchObject({
      role: STAGE_ARTIFACT_ROLE,
      stage: "tts",
      version: "v1",
      durationMs: 900,
      usageCount: 1,
      lastUsedAt: "2026-09-30T12:00:00.000Z",
    });
    expect(d.store.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, assetId: created.id, bytes }),
    );
    expect(d.assets.updateState).toHaveBeenCalledWith({
      workspaceId,
      assetId: created.id,
      state: "active",
    });
    // create -> putObject -> updateState, in that order
    const order = [
      d.assets.create.mock.invocationCallOrder[0],
      d.store.putObject.mock.invocationCallOrder[0],
      d.assets.updateState.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((x, y) => (x ?? 0) - (y ?? 0)));
  });

  it("returns the stored bytes and metadata on a hit without producing", async () => {
    const d = deps([stored()]);
    const p = vi.fn(produce);
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce: p,
    });
    expect(result.hit).toBe(true);
    expect(result.assetId).toBe("cached-1");
    expect(result.bytes).toEqual(bytes);
    expect(result.metadata).toMatchObject({ durationMs: 900 });
    expect(p).not.toHaveBeenCalled();
    expect(d.assets.updateMetadata).toHaveBeenCalledWith({
      workspaceId,
      assetId: "cached-1",
      patch: { usageCount: 2, lastUsedAt: "2026-09-30T12:00:00.000Z" },
    });
  });

  it("never hits across workspaces", async () => {
    const d = deps([stored()]);
    const result = await createStageCache(d).getOrProduce({
      workspaceId: otherWorkspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(false);
    expect(d.assets.listByMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: otherWorkspaceId }),
    );
  });

  it("misses when the version differs", async () => {
    const d = deps([stored()]);
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v2",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(false);
  });

  it("stores nothing when produce throws", async () => {
    const d = deps();
    await expect(
      createStageCache(d).getOrProduce({
        workspaceId,
        stage: "tts",
        version: "v1",
        inputs: { text: "oi" },
        produce: async () => {
          throw new Error("voice_synthesis_failed:timeout");
        },
      }),
    ).rejects.toThrow("voice_synthesis_failed:timeout");
    expect(d.assets.create).not.toHaveBeenCalled();
    expect(d.store.putObject).not.toHaveBeenCalled();
  });

  it("treats a checksum mismatch on download as a miss", async () => {
    const d = deps([stored()], new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9]));
    const p = vi.fn(produce);
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce: p,
    });
    expect(result.hit).toBe(false);
    expect(p).toHaveBeenCalledOnce();
    expect(d.assets.create).toHaveBeenCalledOnce();
  });

  it("treats a download failure as a miss", async () => {
    const d = deps([stored()]);
    d.fetchBytes.mockRejectedValueOnce(new Error("media_fetch_failed"));
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(false);
  });

  it("ignores a failing usage-counter update on a hit", async () => {
    const d = deps([stored()]);
    d.assets.updateMetadata.mockRejectedValueOnce(new Error("db_down"));
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(true);
  });

  it("takes the newest entry when two share a key", async () => {
    const older = stored({ id: "cached-old" });
    const newer = stored({ id: "cached-new" });
    // listByMetadata orders newest first (repository contract)
    const d = deps([newer, older]);
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.assetId).toBe("cached-new");
  });

  it("treats a failing lookup as a miss", async () => {
    const d = deps();
    d.assets.listByMetadata.mockRejectedValueOnce(new Error("db_down"));
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result.hit).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  it("returns the produced artifact when storing it fails", async () => {
    const d = deps();
    d.store.putObject.mockRejectedValueOnce(new Error("r2_down"));
    const result = await createStageCache(d).getOrProduce({
      workspaceId,
      stage: "tts",
      version: "v1",
      inputs: { text: "oi" },
      produce,
    });
    expect(result).toMatchObject({ hit: false, bytes, mimeType: "audio/wav" });
    expect(d.assets.updateState).not.toHaveBeenCalled();
  });
});
