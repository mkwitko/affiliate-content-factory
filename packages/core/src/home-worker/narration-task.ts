import type { WorkspaceId } from "@money-maker/contracts";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import { modelPolicyFor } from "../assets/model-policy.js";
import type { ContentRepository } from "../content/content-repository.js";
import type { ClaimedJob } from "../jobs/job.js";
import {
  compareNarration,
  MAX_TRANSCRIPT_LENGTH,
  NARRATION_ASR_MODEL,
} from "../publishing/narration-check.js";
import type { ReelRenderRepository } from "../publishing/reel-render.js";
import { TaskError } from "./task-error.js";

/**
 * check_narration (speech_recognition): the home machine transcribes the audio of a voiced
 * Reel; the server compares the transcript with the voice script (publishing/narration-check)
 * and stores the finding in the render's quality report. Nothing here trusts the machine beyond
 * the transcript text, and only the allowlisted ASR model is accepted.
 */
export type NarrationDeps = Readonly<{
  reels: Pick<ReelRenderRepository, "findForWorkspace" | "recordNarrationCheck">;
  variants: Pick<ContentRepository, "findVariantForWorkspace">;
  assets: Pick<AssetRepository, "findForWorkspace">;
  store: Pick<AssetStore, "createDownload">;
  now: () => Date;
}>;

export type NarrationTask = Readonly<{
  kind: "check_narration";
  jobId: string;
  leaseToken: string;
  /** Short-lived signed download of the rendered Reel (MP4); the machine extracts the audio. */
  videoUrl: string;
  /** BCP 47-ish language of the narration, for the ASR. */
  language: string;
  /** What was spoken, one entry per voice-script line. */
  lines: readonly string[];
}>;

export type NarrationResult = Readonly<{
  kind: "check_narration";
  /** Raw ASR text; compared server side. */
  transcript: string;
  model: string;
  provenance?: Readonly<{ runtime: string; observedModel?: string; runtimeVersion?: string }>;
}>;

const MAX_LINES = 40;

const narrationTarget = async (
  deps: NarrationDeps,
  workspaceId: WorkspaceId,
  sourceVariantId: string,
  assetId: string,
) => {
  const render = await deps.reels.findForWorkspace({ workspaceId, sourceVariantId });
  if (render?.status !== "ready" || render.assetId !== assetId || !render.qualityReport)
    throw new TaskError("narration_render_changed");
  if (render.qualityReport.narration) throw new TaskError("already_checked");
  const variant = await deps.variants.findVariantForWorkspace({
    workspaceId,
    variantId: sourceVariantId,
  });
  // Silent Reels have nothing to check.
  if (render.voiceMode !== "script" || !variant || variant.voiceScript.length === 0) return null;
  const asset = await deps.assets.findForWorkspace({ workspaceId, assetId });
  if (asset?.state !== "active" || asset.mimeType !== "video/mp4")
    throw new TaskError("narration_asset_unavailable");
  return { variant, lines: variant.voiceScript.slice(0, MAX_LINES) };
};

/** The job's payload identifiers (already parsed by the caller). */
const idsOf = (ids: Readonly<Record<string, string>>) => {
  if (!ids.sourceVariantId || !ids.assetId) throw new TaskError("narration_ids_missing");
  return { sourceVariantId: ids.sourceVariantId, assetId: ids.assetId };
};

export const buildNarrationTask = async (
  deps: NarrationDeps,
  job: ClaimedJob,
  ids: Readonly<Record<string, string>>,
): Promise<NarrationTask | "done"> => {
  const { sourceVariantId, assetId } = idsOf(ids);
  const target = await narrationTarget(deps, job.workspaceId, sourceVariantId, assetId);
  if (!target) return "done";
  const download = await deps.store.createDownload({ workspaceId: job.workspaceId, assetId });
  return {
    kind: "check_narration",
    jobId: job.id,
    leaseToken: job.leaseToken,
    videoUrl: download.url,
    language: target.variant.language,
    lines: target.lines,
  };
};

export const applyNarration = async (
  deps: NarrationDeps,
  job: ClaimedJob,
  ids: Readonly<Record<string, string>>,
  result: NarrationResult,
): Promise<void> => {
  const { sourceVariantId, assetId } = idsOf(ids);
  if (result.model !== NARRATION_ASR_MODEL || modelPolicyFor(result.model)?.enabled !== true)
    throw new TaskError("narration_model_not_allowlisted");
  if (result.transcript.length > MAX_TRANSCRIPT_LENGTH)
    throw new TaskError("narration_transcript_too_long");
  const target = await narrationTarget(deps, job.workspaceId, sourceVariantId, assetId);
  if (!target) throw new TaskError("narration_not_voiced");
  const stored = await deps.reels.recordNarrationCheck({
    workspaceId: job.workspaceId,
    sourceVariantId,
    assetId,
    narration: compareNarration(target.lines, result.transcript, {
      model: result.model,
      now: deps.now(),
    }),
  });
  if (!stored) throw new TaskError("narration_render_changed");
};
