import type { WorkspaceId } from "@money-maker/contracts";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  type FrameReviewer,
  keyFramePlan,
  reviewFrames,
  type VlmFrame,
  withVlmReview,
} from "@money-maker/core/explainer/visual-qa/vlm-review";

export { keyFramePlan } from "@money-maker/core/explainer/visual-qa/vlm-review";

import {
  type JobContext,
  type JobIdentifierPayload,
  PermanentJobError,
} from "@money-maker/core/jobs/job";
import type { LongFormRenderRepository } from "@money-maker/core/publishing/long-form-render";

/** One review job per render; a finished review is never redone (see the handler). */
export const createReviewFramesJob = (input: { workspaceId: WorkspaceId; renderId: string }) => ({
  name: "review_frames",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { renderId: input.renderId },
  },
  idempotencyKey: `review-frames:${input.renderId}`,
  attemptPolicy: { maxAttempts: 2 },
});

export type ReviewFramesDependencies = Readonly<{
  renders: Pick<LongFormRenderRepository, "findForWorkspace"> &
    Required<Pick<LongFormRenderRepository, "recordVisualReview">>;
  assets: Pick<AssetRepository, "findForWorkspace">;
  store: Pick<AssetStore, "createDownload">;
  fetchVideo: (url: string) => Promise<Uint8Array>;
  extractFrames: (video: Uint8Array, timesMs: readonly number[]) => Promise<readonly Uint8Array[]>;
  reviewer: FrameReviewer;
  model?: string;
}>;

/**
 * review_frames (v2 slice 29): key frames of a READY render go to the local VLM and the advisory
 * findings are appended to the stored quality report's `visual` section. Fallbacks (spec 22): an
 * unreachable or unreadable reviewer records `vlm: "skipped"` and the job still succeeds; the
 * deterministic findings stay exactly as they were, including every BLOCK.
 */
export const createReviewFramesHandler =
  (deps: ReviewFramesDependencies) =>
  async (job: { payload: JobIdentifierPayload }, context?: JobContext): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    const renderId = identifiers.renderId;
    if (!renderId) throw new PermanentJobError("review_render_id_missing");
    const render = await deps.renders.findForWorkspace({ workspaceId, renderId });
    const manifest = render?.timingManifest;
    if (render?.status !== "ready" || !render.assetId || !manifest || !render.qualityReport)
      throw new PermanentJobError("render_not_reviewable");
    if (render.qualityReport.visual?.vlm?.vlm === "reviewed") return;
    const asset = await deps.assets.findForWorkspace({ workspaceId, assetId: render.assetId });
    if (
      !asset ||
      asset.workspaceId !== workspaceId ||
      asset.state !== "active" ||
      asset.mimeType !== "video/mp4" ||
      asset.checksum !== manifest.renderedAssetChecksum
    )
      throw new PermanentJobError("render_asset_unavailable");
    const download = await deps.store.createDownload({ workspaceId, assetId: asset.id });
    const video = await deps.fetchVideo(download.url);
    const plan = keyFramePlan(manifest.scenes);
    const pngs = await deps.extractFrames(
      video,
      plan.map((entry) => entry.timeMs),
    );
    const frames: VlmFrame[] = plan.flatMap((entry, index) => {
      const png = pngs[index];
      return png ? [{ sceneIndex: entry.sceneIndex, hook: entry.hook, png }] : [];
    });
    const result = await reviewFrames(deps.reviewer, frames, {
      ...(deps.model ? { model: deps.model } : {}),
    });
    context?.signal.throwIfAborted();
    const visual = withVlmReview(
      render.qualityReport.visual ?? { findings: [], colorStrip: [] },
      result,
    );
    const stored = await deps.renders.recordVisualReview({ workspaceId, renderId, visual });
    if (!stored) throw new PermanentJobError("render_not_reviewable");
    console.info("frames_reviewed", {
      renderId,
      vlm: result.record.vlm,
      reason: result.record.reason,
      findings: result.findings.length,
      latencyMs: result.record.latencyMs,
    });
  };
