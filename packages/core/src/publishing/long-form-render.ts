import type { WorkspaceId } from "@money-maker/contracts";
import type { Storyboard } from "../content/storyboard.js";
import type { JobQueue } from "../jobs/job.js";
import type { RenderQualityReport } from "./render-quality.js";
import type { RenderTimingManifest } from "./render-timing-manifest.js";

export type LongFormRender = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  storyboardId: string;
  attempt: number;
  status: "pending" | "ready" | "failed";
  reason?: string;
  assetId?: string;
  durationMs?: number;
  wallTimeMs?: number;
  timingManifest?: RenderTimingManifest;
  /** Post-render quality gate; absent on renders made before the gate or never measured. */
  qualityReport?: RenderQualityReport;
  rendererVersion: number;
  createdAt: Date;
  updatedAt: Date;
}>;
export type RecentLongFormRender = Readonly<{
  render: LongFormRender;
  contentItemId: string;
  contentTitle: string;
}>;
export interface LongFormRenderRepository {
  createPending(input: {
    id: string;
    workspaceId: WorkspaceId;
    storyboardId: string;
    rendererVersion: number;
  }): Promise<{ created: boolean; render: LongFormRender }>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    renderId: string;
  }): Promise<LongFormRender | null>;
  listRecentForWorkspace(input: {
    workspaceId: WorkspaceId;
    limit: number;
  }): Promise<readonly RecentLongFormRender[]>;
  recordReady(input: {
    workspaceId: WorkspaceId;
    renderId: string;
    assetId: string;
    assetChecksum: string;
    durationMs: number;
    wallTimeMs: number;
    timingManifest: RenderTimingManifest;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<LongFormRender>;
  recordFailed(input: {
    workspaceId: WorkspaceId;
    renderId: string;
    reason: string;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<LongFormRender>;
  /** Replaces the `visual` section of a READY render's stored quality report (v2 slice 29). */
  recordVisualReview?(input: {
    workspaceId: WorkspaceId;
    renderId: string;
    visual: NonNullable<RenderQualityReport["visual"]>;
  }): Promise<LongFormRender | null>;
}
export const createRenderLongFormJob = (input: {
  workspaceId: WorkspaceId;
  renderId: string;
  attempt: number;
}) => ({
  name: "render_long_form",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { renderId: input.renderId },
  },
  idempotencyKey: `long-form-render:${input.renderId}:${input.attempt}`,
  attemptPolicy: { maxAttempts: 2 },
});
/**
 * One run is one short poll. The wall-clock deadline (SCENE_CLIPS_DEADLINE_MS, from the render's
 * creation) is the real limit; this run cap is only a generous safety net against a retry loop.
 */
export const GENERATE_SCENE_CLIPS_MAX_ATTEMPTS = 600;
export const SCENE_CLIPS_DEADLINE_MS = 3 * 3_600_000;
export const createGenerateSceneClipsJob = (input: {
  workspaceId: WorkspaceId;
  renderId: string;
  attempt: number;
}) => ({
  name: "generate_scene_clips",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { renderId: input.renderId },
  },
  idempotencyKey: `scene-clips:${input.renderId}:${input.attempt}`,
  attemptPolicy: { maxAttempts: GENERATE_SCENE_CLIPS_MAX_ATTEMPTS },
});
/**
 * Local Wan clips (spec 2026-10-02, decision 7): one home-queue job per scene, chained: a finished scene
 * completes its job and enqueues the next scene's, so scene progress never burns attempts (the
 * queue caps them at 12). Attempts cover the one retry per scene plus slack for home-side failures.
 */
export const createGenerateClipsJob = (input: {
  workspaceId: WorkspaceId;
  renderId: string;
  attempt: number;
  sceneIndex: number;
}) => ({
  name: "generate_clips",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { renderId: input.renderId },
  },
  idempotencyKey: `local-clips:${input.renderId}:${input.attempt}:${input.sceneIndex}`,
  attemptPolicy: { maxAttempts: 3 },
});
export const requestLongFormRender = async (input: {
  workspaceId: WorkspaceId;
  storyboard: Storyboard;
  renderId: string;
  rendererVersion: number;
  renders: LongFormRenderRepository;
  jobs: Pick<JobQueue, "enqueue">;
}) => {
  if (input.storyboard.workspaceId !== input.workspaceId) throw new Error("workspace_mismatch");
  const result = await input.renders.createPending({
    id: input.renderId,
    workspaceId: input.workspaceId,
    storyboardId: input.storyboard.id,
    rendererVersion: input.rendererVersion,
  });
  if (result.created)
    // ai_clips first generates its clips; that job enqueues render_long_form once all are stored.
    await input.jobs.enqueue(
      (input.storyboard.renderer === "ai_clips"
        ? createGenerateSceneClipsJob
        : createRenderLongFormJob)({
        workspaceId: input.workspaceId,
        renderId: result.render.id,
        attempt: result.render.attempt,
      }),
    );
  return result;
};
