import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import type { McpDependencies } from "../server.js";
import { describe, expect, it, vi } from "vitest";
import { getOwnedClipRenderTool, renderOwnedClipTool } from "./owned-clip-render.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const script = {
  id: "script-1",
  workspaceId,
  contentItemId: "master-item",
  version: 1,
  status: "approved",
  body: "The answer",
  language: "en",
  claims: [],
  beats: [],
  checksum: "b".repeat(64),
  createdAt: new Date(),
  approvedBy: actorId,
  approvedAt: new Date(),
  approvedChecksum: "b".repeat(64),
  actorId,
};
const manifest = buildRenderTimingManifest({
  workspaceId,
  renderId: "render-1",
  storyboardId: "board-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: script.id,
  scriptChecksum: script.checksum,
  scriptLength: script.body.length,
  renderedAssetId: "source-video",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 5000,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-26T12:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: script.body.length,
      startMs: 0,
      endMs: 5000,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "d".repeat(64),
    },
  ],
  words: [
    { text: "The", fromChar: 0, toChar: 3, startMs: 1000, endMs: 1200, sceneIndex: 1 },
    { text: "answer", fromChar: 4, toChar: 10, startMs: 1300, endMs: 1800, sceneIndex: 1 },
  ],
});
const source = {
  id: "source-video",
  workspaceId,
  objectKey: "source-key",
  checksum: "c".repeat(64),
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  durationMs: 5000,
  provenance: "rendered",
  license: "owned source",
  commercialUse: true,
  state: "active",
  metadata: { role: "long_form_video" },
};

const createDependencies = (scenes: readonly { captionMode: "none" | "line" | "word" }[] = []) => {
  const assets = new Map([[source.id, source]]);
  const jobs: unknown[] = [];
  const deps = {
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
    },
    contentRepository: {
      findContentItemForWorkspace: async () => ({
        id: "child-item",
        workspaceId,
        nicheId: "niche-1",
        offerId: null,
        offerSnapshotId: null,
        sourceContentItemId: "master-item",
        title: "Short insight",
        sourceFactKeys: [],
        creativeOpinion: "A concise standalone insight.",
        state: "draft",
      }),
    },
    storyboardRepository: {
      findForWorkspace: async () => ({
        id: "board-1",
        workspaceId,
        contentItemId: "master-item",
        scriptId: script.id,
        scenes,
      }),
    },
    editorialRepository: { findScriptForWorkspace: async () => script },
    longFormRenderRepository: {
      findForWorkspace: async () => ({
        id: "render-1",
        workspaceId,
        storyboardId: "board-1",
        status: "ready",
        assetId: source.id,
        durationMs: manifest.durationMs,
        rendererVersion: 1,
        timingManifest: manifest,
      }),
    },
    assetRepository: {
      findForWorkspace: async ({ assetId }: { assetId: string }) => assets.get(assetId) ?? null,
      create: async (asset: typeof source & { state: string }) => {
        assets.set(asset.id, asset as never);
        return asset;
      },
      updateMetadata: vi.fn(
        async ({ assetId, patch }: { assetId: string; patch: Record<string, unknown> }) => {
          const asset = assets.get(assetId);
          if (!asset) return null;
          const updated = { ...asset, metadata: { ...asset.metadata, ...patch } };
          assets.set(assetId, updated);
          return updated;
        },
      ),
    },
    assetStore: {
      createDownload: async () => ({ method: "GET", url: "https://assets.test/source.mp4" }),
    },
    jobQueue: { enqueue: async (job: never) => void jobs.push(job) },
  } as unknown as McpDependencies;
  return { deps, assets, jobs };
};

describe("owned clip render tools", () => {
  it("creates an idempotent pending derivative render without publishing", async () => {
    const { deps, assets, jobs } = createDependencies();
    const input = {
      workspaceId,
      sourceRenderId: "render-1",
      childContentItemId: "child-item",
      fromChar: 0,
      toChar: script.body.length,
      origin: "discovered",
      rationale: "The answer forms a useful complete moment.",
    };

    const first = await renderOwnedClipTool(input, actorId, deps);
    const second = await renderOwnedClipTool(input, actorId, deps);

    expect(first).toMatchObject({ ok: true, value: { status: "pending", attempt: 1 } });
    expect(second).toMatchObject({ ok: true, value: { status: "pending", attempt: 1 } });
    expect(jobs).toHaveLength(1);
    expect(
      [...assets.values()].filter((asset) => asset.metadata?.role === "owned_clip"),
    ).toHaveLength(1);
  });

  it("records the vertical safe-layout dimensions for a vertical short", async () => {
    const { deps, assets } = createDependencies();
    const result = await renderOwnedClipTool(
      {
        workspaceId,
        sourceRenderId: "render-1",
        childContentItemId: "child-item",
        fromChar: 0,
        toChar: script.body.length,
        origin: "designed",
        rationale: "A self-contained explanation.",
        layout: "vertical",
      },
      actorId,
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const asset = assets.get(result.value.assetId as string);
    expect(asset).toMatchObject({ width: 1080, height: 1920 });
    expect(asset?.metadata).toMatchObject({
      layout: "vertical",
      derivedContentItemId: "child-item",
    });
  });

  const blurArgs = {
    workspaceId,
    sourceRenderId: "render-1",
    childContentItemId: "child-item",
    fromChar: 0,
    toChar: script.body.length,
    origin: "designed",
    rationale: "A self-contained explanation.",
  };

  it("records vertical dimensions and adapts captions for blur and focus layouts", async () => {
    for (const layout of ["vertical_blur", "vertical_focus"] as const) {
      const { deps, assets } = createDependencies([{ captionMode: "none" }]);
      const result = await renderOwnedClipTool(
        { ...blurArgs, layout, captionTreatment: "adaptive" },
        actorId,
        deps,
      );
      expect(result).toMatchObject({ ok: true, value: { captionTreatment: "adapted" } });
      if (!result.ok) return;
      const asset = assets.get(result.value.assetId as string);
      expect(asset).toMatchObject({ width: 1080, height: 1920 });
      expect(asset?.metadata).toMatchObject({ layout });
    }
  });

  it("stores vertical for a portrait source and keeps layouts on distinct requests", async () => {
    const portrait = createDependencies();
    portrait.assets.set(source.id, { ...source, width: 1080, height: 1920 });
    const result = await renderOwnedClipTool(
      { ...blurArgs, layout: "vertical_blur" },
      actorId,
      portrait.deps,
    );
    if (!result.ok) throw new Error("expected ok");
    expect(portrait.assets.get(result.value.assetId as string)?.metadata).toMatchObject({
      layout: "vertical",
    });
    const both = createDependencies();
    const a = await renderOwnedClipTool({ ...blurArgs, layout: "vertical" }, actorId, both.deps);
    const b = await renderOwnedClipTool(
      { ...blurArgs, layout: "vertical_blur" },
      actorId,
      both.deps,
    );
    if (!a.ok || !b.ok) throw new Error("expected ok");
    expect(a.value.assetId).not.toBe(b.value.assetId);
  });

  it("adapts captions only for a captionless master with aligned timing", async () => {
    const { deps, assets } = createDependencies([{ captionMode: "none" }]);
    const result = await renderOwnedClipTool(
      {
        workspaceId,
        sourceRenderId: "render-1",
        childContentItemId: "child-item",
        fromChar: 0,
        toChar: script.body.length,
        origin: "designed",
        rationale: "A self-contained explanation.",
        layout: "vertical",
        captionTreatment: "adaptive",
      },
      actorId,
      deps,
    );

    expect(result).toMatchObject({ ok: true, value: { captionTreatment: "adapted" } });
    if (!result.ok) return;
    expect(assets.get(result.value.assetId as string)?.metadata).toMatchObject({
      captionTreatment: "adapted",
    });
  });

  it("preserves burned-in source captions instead of adding a duplicate track", async () => {
    const { deps, assets } = createDependencies([{ captionMode: "word" }]);
    const result = await renderOwnedClipTool(
      {
        workspaceId,
        sourceRenderId: "render-1",
        childContentItemId: "child-item",
        fromChar: 0,
        toChar: script.body.length,
        origin: "designed",
        rationale: "A self-contained explanation.",
        layout: "vertical",
        captionTreatment: "adaptive",
      },
      actorId,
      deps,
    );

    expect(result).toMatchObject({ ok: true, value: { captionTreatment: "inherited" } });
    if (!result.ok) return;
    expect(assets.get(result.value.assetId as string)?.metadata).toMatchObject({
      captionTreatment: "inherited",
    });
  });

  it("does not return another workspace's clip asset", async () => {
    const { deps } = createDependencies();
    const result = await getOwnedClipRenderTool(
      { workspaceId, assetId: "another-workspace-asset" },
      actorId,
      deps,
    );
    expect(result).toMatchObject({ ok: false, error: "CONTENT_NOT_FOUND" });
  });
});
