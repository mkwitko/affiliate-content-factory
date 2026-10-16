import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { ContentScript } from "@money-maker/core/content/editorial";
import type { LongFormRender } from "@money-maker/core/publishing/long-form-render";
import type { RenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { describe, expect, it, vi } from "vitest";
import {
  createRenderOwnedClipHandler,
  type RenderOwnedClipDependencies,
} from "./render-owned-clip.js";

vi.mock("@money-maker/providers/http/safe-media-fetch", () => ({
  fetchSafeMedia: vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), mimeType: "video/mp4" })),
}));
const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const manifest = {
  renderedAssetId: "source-video",
  renderedAssetChecksum: "a".repeat(64),
  scriptChecksum: "b".repeat(64),
  durationMs: 5000,
} as RenderTimingManifest;
const render = {
  id: "render-1",
  workspaceId,
  storyboardId: "board-1",
  status: "ready",
  assetId: "source-video",
  durationMs: 5000,
  rendererVersion: 1,
  timingManifest: manifest,
} as LongFormRender;
const script = {
  id: "script-1",
  workspaceId,
  contentItemId: "master-item",
  status: "approved",
  checksum: "b".repeat(64),
} as ContentScript;
const source: Asset = {
  id: "source-video",
  workspaceId,
  objectKey: "source-key",
  checksum: "a".repeat(64),
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  provenance: "rendered",
  license: "owned",
  commercialUse: true,
  state: "active",
};
const target: Asset = {
  id: "clip-1",
  workspaceId,
  objectKey: "clip-key",
  checksum: "0".repeat(64),
  mimeType: "video/mp4",
  width: 1920,
  height: 1080,
  durationMs: 1500,
  provenance: "rendered",
  license: "owned",
  commercialUse: null,
  state: "pending",
  metadata: {
    role: "owned_clip",
    renderStatus: "pending",
    sourceRenderId: "render-1",
    sourceContentItemId: "master-item",
    sourceAssetChecksum: source.checksum,
    sourceStartMs: 500,
    sourceEndMs: 2000,
    layout: "source",
  },
};
const job = {
  payload: { version: 1 as const, workspaceId, identifiers: { assetId: target.id } },
};
const dependencies = (
  overrides: Partial<RenderOwnedClipDependencies> = {},
): RenderOwnedClipDependencies => ({
  renders: { findForWorkspace: vi.fn(async () => render) } as never,
  storyboards: {
    findForWorkspace: vi.fn(async () => ({
      id: "board-1",
      contentItemId: "master-item",
      scriptId: script.id,
    })),
  } as never,
  scripts: { findScriptForWorkspace: vi.fn(async () => script) } as never,
  assets: {
    findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) =>
      assetId === source.id ? source : assetId === target.id ? target : null,
    ),
    completeRenderedAsset: vi.fn(async () => ({ ...target, state: "active" as const })),
    updateMetadata: vi.fn(async () => target),
  } as never,
  store: {
    createDownload: vi.fn(async () => ({
      method: "GET" as const,
      url: "https://assets.test/source.mp4",
    })),
    putObject: vi.fn(async () => undefined),
  } as never,
  renderer: {
    render: vi.fn(async () => ({
      bytes: new Uint8Array([3, 4]),
      mimeType: "video/mp4" as const,
      width: 1920,
      height: 1080,
      durationMs: 1500,
    })),
  },
  ...overrides,
});

describe("render_owned_clip worker", () => {
  it("revalidates the approved source and activates a lineage-bearing clip asset", async () => {
    const deps = dependencies();
    await createRenderOwnedClipHandler(deps)(job);

    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({ startMs: 500, endMs: 2000, width: 1920, height: 1080 }),
    );
    expect(deps.store.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: target.id, mimeType: "video/mp4" }),
    );
    expect(deps.assets.completeRenderedAsset).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ renderStatus: "ready" }) }),
    );
  });

  it("does not write the clip object once the job deadline aborted", async () => {
    const controller = new AbortController();
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => {
          controller.abort(new Error("render_timeout"));
          return {
            bytes: new Uint8Array([3, 4]),
            mimeType: "video/mp4" as const,
            width: 1920,
            height: 1080,
            durationMs: 1500,
          };
        }),
      },
    });
    await createRenderOwnedClipHandler(deps)(job, { signal: controller.signal });
    expect(deps.store.putObject).not.toHaveBeenCalled();
    // A timeout is terminal (no retry follows): the clip must not stay pending forever.
    expect(deps.assets.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { renderStatus: "failed", renderFailureReason: "render_timeout" },
      }),
    );
  });

  it("leaves a clip another attempt completed untouched", async () => {
    let targetReads = 0;
    const deps = dependencies({
      assets: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) => {
          if (assetId === source.id) return source;
          if (assetId !== target.id) return null;
          targetReads += 1;
          return targetReads === 1
            ? target
            : {
                ...target,
                state: "active",
                metadata: { ...target.metadata, renderStatus: "ready" },
              };
        }),
        completeRenderedAsset: vi.fn(async () => null),
        updateMetadata: vi.fn(async () => target),
      } as never,
    });
    await createRenderOwnedClipHandler(deps)(job);
    expect(deps.store.putObject).not.toHaveBeenCalled();
    expect(deps.assets.completeRenderedAsset).not.toHaveBeenCalled();
  });

  it("records a terminal failure after the last safe render attempt", async () => {
    const deps = dependencies({
      renderer: {
        render: vi.fn(async () => {
          throw new Error("decoder_failed");
        }),
      },
    });

    await createRenderOwnedClipHandler(deps)({ ...job, attemptCount: 2 });

    expect(deps.assets.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { renderStatus: "failed", renderFailureReason: "decoder_failed" },
      }),
    );
    expect(deps.assets.completeRenderedAsset).not.toHaveBeenCalled();
  });

  it("rejects a renderer output whose dimensions do not match the selected layout", async () => {
    const verticalTarget = {
      ...target,
      width: 1080,
      height: 1920,
      metadata: { ...target.metadata, layout: "vertical" },
    };
    const deps = dependencies({
      assets: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) =>
          assetId === source.id ? source : verticalTarget,
        ),
        completeRenderedAsset: vi.fn(async () => ({ ...verticalTarget, state: "active" as const })),
        updateMetadata: vi.fn(async () => verticalTarget),
      } as never,
    });

    await createRenderOwnedClipHandler(deps)({ ...job, attemptCount: 2 });

    expect(deps.assets.completeRenderedAsset).not.toHaveBeenCalled();
    expect(deps.assets.updateMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ renderFailureReason: "owned_clip_output_invalid" }),
      }),
    );
  });

  it("passes aligned clip-relative captions to the renderer when requested", async () => {
    const timingManifest = buildRenderTimingManifest({
      workspaceId,
      renderId: render.id,
      storyboardId: render.storyboardId,
      storyboardChecksum: "c".repeat(64),
      scriptId: script.id,
      scriptChecksum: script.checksum,
      scriptLength: 10,
      renderedAssetId: source.id,
      renderedAssetChecksum: source.checksum,
      rendererVersion: 1,
      durationMs: 5000,
      audioTimelineOffsetMs: 0,
      measuredAt: "2026-09-28T00:00:00.000Z",
      scenes: [
        {
          index: 1,
          fromChar: 0,
          toChar: 10,
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
    const verticalTarget = {
      ...target,
      width: 1080,
      height: 1920,
      metadata: { ...target.metadata, layout: "vertical", captionTreatment: "adapted" },
    };
    const deps = dependencies({
      renders: {
        findForWorkspace: vi.fn(async () => ({ ...render, timingManifest })),
      } as never,
      storyboards: {
        findForWorkspace: vi.fn(async () => ({
          id: "board-1",
          contentItemId: "master-item",
          scriptId: script.id,
          scenes: [{ captionMode: "none" }],
        })),
      } as never,
      assets: {
        findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) =>
          assetId === source.id ? source : verticalTarget,
        ),
        completeRenderedAsset: vi.fn(async () => ({ ...verticalTarget, state: "active" as const })),
        updateMetadata: vi.fn(async () => verticalTarget),
      } as never,
      renderer: {
        render: vi.fn(async () => ({
          bytes: new Uint8Array([3, 4]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 1500,
        })),
      },
    });

    await createRenderOwnedClipHandler(deps)(job);

    expect(deps.renderer.render).toHaveBeenCalledWith(
      expect.objectContaining({
        layout: "vertical",
        captionWords: [
          { text: "The", startMs: 500, endMs: 700 },
          { text: "answer", startMs: 800, endMs: 1300 },
        ],
      }),
    );
  });

  describe("vertical layouts", () => {
    const twoScenes = buildRenderTimingManifest({
      workspaceId,
      renderId: render.id,
      storyboardId: render.storyboardId,
      storyboardChecksum: "c".repeat(64),
      scriptId: script.id,
      scriptChecksum: script.checksum,
      scriptLength: 10,
      renderedAssetId: source.id,
      renderedAssetChecksum: source.checksum,
      rendererVersion: 1,
      durationMs: 5000,
      audioTimelineOffsetMs: 0,
      measuredAt: "2026-09-28T00:00:00.000Z",
      scenes: [
        {
          index: 1,
          fromChar: 0,
          toChar: 5,
          startMs: 0,
          endMs: 2500,
          sourceAssetId: "s1",
          sourceAssetChecksum: "d".repeat(64),
        },
        {
          index: 2,
          fromChar: 5,
          toChar: 10,
          startMs: 2500,
          endMs: 5000,
          sourceAssetId: "s2",
          sourceAssetChecksum: "d".repeat(64),
        },
      ],
      words: [
        { text: "The", fromChar: 0, toChar: 3, startMs: 1000, endMs: 1200, sceneIndex: 1 },
        { text: "answer", fromChar: 5, toChar: 10, startMs: 3000, endMs: 3800, sceneIndex: 2 },
      ],
    });
    const run = async (
      layout: string,
      scenes: unknown[],
      extra: Record<string, unknown> = {},
      canvas?: string,
    ) => {
      const clip = {
        ...target,
        width: 1080,
        height: 1920,
        metadata: { ...target.metadata, layout, ...extra },
      };
      const deps = dependencies({
        renders: {
          findForWorkspace: vi.fn(async () => ({ ...render, timingManifest: twoScenes })),
        } as never,
        storyboards: {
          findForWorkspace: vi.fn(async () => ({
            id: "board-1",
            contentItemId: "master-item",
            scriptId: script.id,
            scenes,
            ...(canvas ? { canvas } : {}),
          })),
        } as never,
        assets: {
          findForWorkspace: vi.fn(async ({ assetId }: { assetId: string }) =>
            assetId === source.id ? source : clip,
          ),
          completeRenderedAsset: vi.fn(async () => ({ ...clip, state: "active" as const })),
          updateMetadata: vi.fn(async () => clip),
        } as never,
        renderer: {
          render: vi.fn(async () => ({
            bytes: new Uint8Array([3, 4]),
            mimeType: "video/mp4" as const,
            width: 1080,
            height: 1920,
            durationMs: 1500,
          })),
        },
        content: { findContentItemForWorkspace: vi.fn(async () => ({ nicheId: "n1" })) } as never,
        niches: {
          findForWorkspace: vi.fn(async () => ({ context: { captionTheme: { preset: "boxed" } } })),
        } as never,
      });
      await createRenderOwnedClipHandler(deps)(job);
      return deps;
    };

    it("derives the focus track from stored actor positions for vertical_focus", async () => {
      const deps = await run("vertical_focus", [
        { index: 1, actors: [{ position: "left" }], captionMode: "word" },
        { index: 2, actors: [{ position: "right" }], captionMode: "word" },
      ]);
      expect(deps.renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          layout: "vertical_focus",
          focusTrack: {
            cropWidth: 608,
            points: [
              { tMs: 0, x: 229 },
              { tMs: 2500, x: 1083 },
            ],
          },
        }),
      );
    });

    it("reads stage positions in the storyboard's own canvas", async () => {
      const deps = await run(
        "vertical_focus",
        [
          { index: 1, actors: [{ position: "left" }], captionMode: "word" },
          { index: 2, actors: [{ position: "right" }], captionMode: "word" },
        ],
        {},
        "landscape",
      );
      expect(deps.renderer.render).toHaveBeenCalledWith(
        expect.objectContaining({
          focusTrack: {
            cropWidth: 608,
            points: [
              { tMs: 0, x: 116 },
              { tMs: 2500, x: 1196 },
            ],
          },
        }),
      );
    });

    it("sends no focus track when the stored scenes carry no subject position", async () => {
      const deps = await run("vertical_focus", [
        { index: 1, assetId: "a", motion: "static", captionMode: "word" },
        { index: 2, assetId: "b", motion: "static", captionMode: "word" },
      ]);
      const call = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
      expect(call?.layout).toBe("vertical_focus");
      expect(call).not.toHaveProperty("focusTrack");
    });

    it("resolves the caption theme for every vertical layout", async () => {
      for (const layout of ["vertical", "vertical_blur", "vertical_focus"]) {
        const deps = await run(
          layout,
          [
            { index: 1, assetId: "a", motion: "static", captionMode: "none" },
            { index: 2, assetId: "b", motion: "static", captionMode: "none" },
          ],
          { captionTreatment: "adapted" },
        );
        const call = vi.mocked(deps.renderer.render).mock.calls[0]?.[0];
        expect(call?.captionWords?.length).toBeGreaterThan(0);
        expect(call?.captionTheme).toMatchObject({ canvas: "portrait" });
      }
    });
  });
});
