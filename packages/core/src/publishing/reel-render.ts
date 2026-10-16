import type { WorkspaceId } from "@money-maker/contracts";
import type { Channel } from "../channels/channel.js";
import type { ContentVariant } from "../content/content.js";
import { createRenderReelJob, type JobQueue } from "../jobs/job.js";
import type { NarrationCheck } from "./narration-check.js";
import type { RenderQualityReport } from "./render-quality.js";

export type ReelRenderStatus = "pending" | "ready" | "failed";
export type ReelVoiceMode = "script" | "none";

export type ReelRender = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  sourceVariantId: string;
  status: ReelRenderStatus;
  assetId?: string;
  reason?: string;
  /** MusicLibrary track id mixed into the video; absent for a silent Reel. */
  musicTrackId?: string;
  voiceMode: ReelVoiceMode;
  voiceId?: string;
  durationMs?: number;
  /** Post-render quality gate; absent on renders made before the gate or never measured. */
  qualityReport?: RenderQualityReport;
  attempt: number;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface ReelRenderRepository {
  /** Idempotent per (workspaceId, sourceVariantId): a repeat call returns the existing render. */
  createPending(input: {
    id?: string;
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    voiceMode: ReelVoiceMode;
  }): Promise<Readonly<{ created: boolean; render: ReelRender }>>;
  /** Puts a failed or stale render back to pending with attempt + 1 and the given voice mode. */
  resetForRetry(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    voiceMode: ReelVoiceMode;
  }): Promise<ReelRender>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
  }): Promise<ReelRender | null>;
  /** The render that produced this video asset, if any. */
  findByAssetForWorkspace(input: {
    workspaceId: WorkspaceId;
    assetId: string;
  }): Promise<ReelRender | null>;
  recordReady(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    assetId: string;
    musicTrackId?: string;
    voiceId?: string;
    durationMs: number;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<ReelRender>;
  /** Music track ids of the workspace's latest ready Reels, most recent first. */
  recentMusicTrackIds(input: {
    workspaceId: WorkspaceId;
    limit: number;
  }): Promise<readonly string[]>;
  recordFailed(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    reason: string;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<ReelRender>;
  /**
   * Adds the narration check to a READY render's quality report (a mismatch makes the verdict
   * block). Null when the render is no longer ready with that asset or has no report.
   */
  recordNarrationCheck(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    assetId: string;
    narration: NarrationCheck;
  }): Promise<ReelRender | null>;
  /** A READY render whose slides changed becomes FAILED(reason) so requestReelRender re-renders it. */
  invalidateReady(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    reason: string;
  }): Promise<void>;
}

/** Throws channel_not_carousel, content_not_approved, or a workspace/channel mismatch. */
export const assertReelSourceVariant = (
  variant: ContentVariant,
  channel: Channel,
  /** Auto packages render their reels from the still-draft carousel; the reel variants stay drafts. */
  options: Readonly<{ allowDraft?: boolean }> = {},
): void => {
  if (variant.workspaceId !== channel.workspaceId) {
    throw new Error("publication_workspace_mismatch");
  }
  if (variant.channelId !== channel.id) throw new Error("publication_channel_mismatch");
  if (channel.kind !== "instagram_carousel") throw new Error("channel_not_carousel");
  const draftOk =
    options.allowDraft === true &&
    (variant.state === "draft" || variant.state === "ready_for_review");
  if (variant.state !== "approved" && variant.state !== "published" && !draftOk) {
    throw new Error("content_not_approved");
  }
};

/** A pending render stuck longer than this (a worker that died mid-render) is retried. */
export const staleReelRenderMs = 15 * 60_000;

export const requestReelRender = async (
  input: Readonly<{
    workspaceId: WorkspaceId;
    variant: ContentVariant;
    channel: Channel;
    renders: ReelRenderRepository;
    jobs: Pick<JobQueue, "enqueue">;
    renderId: string;
    voiceMode: ReelVoiceMode;
    now?: Date;
    allowDraftSource?: boolean;
  }>,
): Promise<Readonly<{ created: boolean; render: ReelRender }>> => {
  if (
    input.variant.workspaceId !== input.workspaceId ||
    input.channel.workspaceId !== input.workspaceId
  ) {
    throw new Error("publication_workspace_mismatch");
  }
  assertReelSourceVariant(input.variant, input.channel, {
    allowDraft: input.allowDraftSource === true,
  });
  const now = input.now ?? new Date();
  const result = await input.renders.createPending({
    id: input.renderId,
    workspaceId: input.workspaceId,
    sourceVariantId: input.variant.id,
    voiceMode: input.voiceMode,
  });
  let render = result.render;
  let created = result.created;
  if (!created) {
    const stale =
      render.status === "pending" && now.getTime() - render.updatedAt.getTime() > staleReelRenderMs;
    if (render.status === "failed" || stale) {
      const previousAttempt = render.attempt;
      render = await input.renders.resetForRetry({
        workspaceId: input.workspaceId,
        sourceVariantId: input.variant.id,
        voiceMode: input.voiceMode,
      });
      // resetForRetry is a no-op when the row is no longer FAILED/PENDING (it raced to READY
      // in another worker); only treat it as a real reset when the attempt actually moved.
      created = render.status === "pending" && render.attempt === previousAttempt + 1;
    }
  }
  if (created) {
    await input.jobs.enqueue(
      createRenderReelJob({
        workspaceId: input.workspaceId,
        sourceVariantId: input.variant.id,
        attempt: render.attempt,
      }),
    );
  }
  return { created, render };
};
