import { createHash } from "node:crypto";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  type ClipRenderer,
  isVerticalLayout,
  OWNED_CLIP_LAYOUTS,
  type OwnedClipLayout,
} from "@money-maker/core/assets/clip-renderer";
import { resolveNicheCaptionTheme } from "@money-maker/core/brand/caption-style";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import { isClipScene } from "@money-maker/core/content/storyboard";
import type { StoryboardRepository } from "@money-maker/core/content/storyboard-repository";
import { focusTrack, sceneFocusX } from "@money-maker/core/explainer/focus-track";
import {
  type JobContext,
  type JobIdentifierPayload,
  jobAbortReason,
} from "@money-maker/core/jobs/job";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { LongFormRenderRepository } from "@money-maker/core/publishing/long-form-render";
import { buildOwnedClipCaptionWords } from "@money-maker/core/publishing/owned-clip-captions";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";

const maxSourceBytes = 250_000_000;
export type RenderOwnedClipDependencies = Readonly<{
  renders: LongFormRenderRepository;
  storyboards: StoryboardRepository;
  scripts: EditorialRepository;
  assets: AssetRepository;
  store: AssetStore;
  renderer: ClipRenderer;
  /** Both needed to read the niche caption theme; absent keeps the legacy clip captions. */
  content?: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches?: Pick<NicheRepository, "findForWorkspace">;
}>;

export const createRenderOwnedClipHandler =
  (deps: RenderOwnedClipDependencies) =>
  async (
    job: { payload: JobIdentifierPayload; attemptCount?: number },
    context?: JobContext,
  ): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    const assetId = identifiers.assetId;
    if (!assetId) throw new Error("owned_clip_asset_id_missing");
    const target = await deps.assets.findForWorkspace({ workspaceId, assetId });
    const metadata = target?.metadata;
    if (
      !target ||
      target.workspaceId !== workspaceId ||
      target.state !== "pending" ||
      target.mimeType !== "video/mp4" ||
      metadata?.role !== "owned_clip" ||
      metadata.renderStatus !== "pending" ||
      typeof metadata.sourceRenderId !== "string" ||
      typeof metadata.sourceStartMs !== "number" ||
      typeof metadata.sourceEndMs !== "number" ||
      typeof metadata.sourceAssetChecksum !== "string" ||
      !OWNED_CLIP_LAYOUTS.includes(metadata.layout as OwnedClipLayout)
    )
      return;

    const fail = async (reason: string) => {
      await deps.assets.updateMetadata?.({
        workspaceId,
        assetId,
        patch: { renderStatus: "failed", renderFailureReason: reason.slice(0, 300) },
      });
    };

    try {
      const render = await deps.renders.findForWorkspace({
        workspaceId,
        renderId: metadata.sourceRenderId,
      });
      if (!render || render.status !== "ready" || !render.assetId || !render.timingManifest)
        throw new Error("source_render_unavailable");
      const board = await deps.storyboards.findForWorkspace({
        workspaceId,
        storyboardId: render.storyboardId,
      });
      const script = board
        ? await deps.scripts.findScriptForWorkspace({ workspaceId, scriptId: board.scriptId })
        : null;
      if (
        !board ||
        !script ||
        script.status !== "approved" ||
        script.checksum !== render.timingManifest.scriptChecksum ||
        render.assetId !== render.timingManifest.renderedAssetId ||
        render.durationMs !== render.timingManifest.durationMs ||
        target.metadata?.sourceContentItemId !== board.contentItemId
      )
        throw new Error("source_binding_mismatch");

      let captionWords: ReturnType<typeof buildOwnedClipCaptionWords> = null;
      if (metadata.captionTreatment === "adapted") {
        if (
          !isVerticalLayout(metadata.layout) ||
          board.scenes.length === 0 ||
          board.scenes.some((scene) => scene.captionMode !== "none")
        )
          throw new Error("clip_caption_binding_mismatch");
        captionWords = buildOwnedClipCaptionWords({
          manifest: render.timingManifest,
          startMs: metadata.sourceStartMs,
          endMs: metadata.sourceEndMs,
        });
        if (!captionWords?.length) throw new Error("clip_caption_timing_unavailable");
      }

      let captionTheme: ReturnType<typeof resolveNicheCaptionTheme>;
      if (captionWords) {
        const item = await deps.content?.findContentItemForWorkspace({
          workspaceId,
          contentItemId: board.contentItemId,
        });
        const niche = item
          ? await deps.niches?.findForWorkspace({ workspaceId, nicheId: item.nicheId })
          : null;
        captionTheme = resolveNicheCaptionTheme({ niche, canvas: "portrait" });
      }
      const source = await deps.assets.findForWorkspace({ workspaceId, assetId: render.assetId });
      if (
        !source ||
        source.workspaceId !== workspaceId ||
        source.state !== "active" ||
        source.mimeType !== "video/mp4" ||
        source.checksum !== metadata.sourceAssetChecksum ||
        source.checksum !== render.timingManifest.renderedAssetChecksum
      )
        throw new Error("source_asset_unavailable");
      const download = await deps.store.createDownload({ workspaceId, assetId: source.id });
      const media = await fetchSafeMedia(new URL(download.url), {
        maxBytes: maxSourceBytes,
        allowedMimeTypes: ["video/mp4"],
      });
      // Focus per stored scene, read in the storyboard's own canvas; with none the renderer falls
      // back to vertical_blur.
      const track =
        metadata.layout === "vertical_focus"
          ? focusTrack({
              scenes: render.timingManifest.scenes.map((scene) => {
                const stored = board.scenes[scene.index - 1];
                return {
                  startMs: scene.startMs,
                  endMs: scene.endMs,
                  focusX:
                    stored && !isClipScene(stored) ? sceneFocusX(stored, board.canvas) : undefined,
                };
              }),
              sourceWidth: source.width,
              sourceHeight: source.height,
            })
          : null;
      const output = await deps.renderer.render({
        sourceBytes: media.bytes,
        startMs: metadata.sourceStartMs,
        endMs: metadata.sourceEndMs,
        width: source.width,
        height: source.height,
        layout: metadata.layout as OwnedClipLayout,
        ...(captionWords ? { captionWords } : {}),
        ...(captionTheme ? { captionTheme } : {}),
        ...(track ? { focusTrack: track } : {}),
      });
      if (
        output.mimeType !== "video/mp4" ||
        output.bytes.byteLength === 0 ||
        output.width !== target.width ||
        output.height !== target.height ||
        !Number.isSafeInteger(output.durationMs) ||
        output.durationMs <= 0 ||
        output.durationMs > 180_000
      )
        throw new Error("owned_clip_output_invalid");
      // The clip's object key is fixed (its pending asset id), so check right before the only
      // write: a worker past its deadline, or one another attempt beat, must not overwrite it.
      // ponytail: a window remains between this read and putObject; closing it needs a
      // per-attempt asset id (or a conditional put), not needed while the deadline fits the lease.
      context?.signal.throwIfAborted();
      const current = await deps.assets.findForWorkspace({ workspaceId, assetId });
      if (current?.state !== "pending" || current.metadata?.renderStatus !== "pending") return;
      const checksum = createHash("sha256").update(output.bytes).digest("hex");
      await deps.store.putObject({
        workspaceId,
        assetId,
        mimeType: output.mimeType,
        checksum,
        width: output.width,
        height: output.height,
        bytes: output.bytes,
      });
      const completed = await deps.assets.completeRenderedAsset({
        workspaceId,
        assetId,
        checksum,
        byteSize: output.bytes.byteLength,
        durationMs: output.durationMs,
        width: output.width,
        height: output.height,
        metadata: { ...metadata, renderStatus: "ready" },
      });
      if (!completed) throw new Error("owned_clip_asset_not_pending");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "owned_clip_render_failed";
      // A timeout fails the job permanently, so no later attempt would resolve the clip.
      if ((job.attemptCount ?? 1) < 2 && jobAbortReason(context?.signal) !== "render_timeout")
        throw error;
      await fail(reason);
    }
  };
