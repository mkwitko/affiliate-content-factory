import type { WorkspaceId } from "@money-maker/contracts";

/**
 * Replaceable port for generated scene clips (spec 2026-09-30 generative scene clips, 4.1).
 * Core defines the shape only; packages/providers holds the hosted Agnes adapter. Submit and poll
 * are separate so a polling timeout never resubmits (INV-G4).
 */
/** Stage-cache stage name of stored clips; also how rights checks recognise them. */
export const SCENE_CLIP_STAGE = "scene_clip";
export type SceneClipRequest = Readonly<{
  prompt: string;
  negativePrompt: string;
  mode: "text" | "image" | "keyframes";
  /** Signed URLs of our own assets, at most 5. */
  referenceImageUrls?: readonly string[];
  width: number;
  height: number;
  seconds: number;
  seed?: number;
  /** `sha256:<hex>` of each reference, same order (paid adapters verify inputs remotely). */
  referenceChecksums?: readonly string[];
  /** Paid adapters reserve budget under this key; a re-submit with the same key never pays twice. */
  budget?: Readonly<{ workspaceId: WorkspaceId; operationKey: string }>;
}>;
/** `submittedAt` (ISO) lets an adapter tell "not visible yet" from "lost" across worker restarts. */
export type SceneClipTask = Readonly<{
  providerTaskId: string;
  model: string;
  submittedAt?: string;
}>;
export type SceneClipPoll =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; url: string }>
  | Readonly<{ status: "failed"; code: string; retryable: boolean }>;
/** A submit the provider refused or could not take; carries only a code, never request data. */
export class SceneClipSubmitError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "SceneClipSubmitError";
  }
}
export interface SceneClipGenerator {
  submit(request: SceneClipRequest): Promise<SceneClipTask>;
  poll(task: SceneClipTask): Promise<SceneClipPoll>;
}
