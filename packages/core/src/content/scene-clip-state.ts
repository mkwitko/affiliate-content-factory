import type { WorkspaceId } from "@money-maker/contracts";

/**
 * Mutable generation progress for an ai_clips storyboard, keyed by scene index. It lives beside
 * the immutable, checksummed scenes (spec 4.2; ruling 1 of the plan) so progress never changes
 * the storyboard checksum an approval binds to.
 */
export type SceneClipState = Readonly<{
  /** `fallback_static`: local generation failed twice; render the reference plate as a zoom clip. */
  status: "queued" | "submitted" | "ready" | "failed" | "fallback_static";
  /** Stored before the first poll; a polling timeout never resubmits (INV-G4). */
  providerTaskId?: string | undefined;
  model?: string | undefined;
  submittedAt?: string | undefined;
  /** The stored clip asset once downloaded and checked. */
  assetId?: string | undefined;
  attempts: number;
  lastError?: string | undefined;
  /** ISO time before which a retryable failure is not resubmitted. */
  nextAttemptAt?: string | undefined;
}>;
export type SceneClipStates = Readonly<Record<string, SceneClipState>>;

export interface SceneClipStateRepository {
  read(input: { workspaceId: WorkspaceId; storyboardId: string }): Promise<SceneClipStates>;
  /** Replaces one scene's state atomically; other scenes are untouched. */
  write(input: {
    workspaceId: WorkspaceId;
    storyboardId: string;
    sceneIndex: number;
    state: SceneClipState;
  }): Promise<void>;
}
