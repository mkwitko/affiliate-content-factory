import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";

export type JobIdentifierPayload = Readonly<{
  version: 1;
  workspaceId: WorkspaceId;
  identifiers: Readonly<Record<string, string>>;
}>;

export type AttemptPolicy = Readonly<{ maxAttempts: number }>;

export type EnqueueJobInput = Readonly<{
  name: string;
  payload: unknown;
  idempotencyKey: string;
  attemptPolicy: AttemptPolicy;
  /** The job is not claimed before this time; absent means now. */
  availableAt?: Date;
}>;

export const createPublishContentJobPayload = (
  input: Readonly<{
    workspaceId: WorkspaceId;
    attemptId: string;
  }>,
): JobIdentifierPayload =>
  parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { attemptId: input.attemptId },
  });

/** The queue gives a publish job this many runs before marking it failed. */
export const publishContentMaxAttempts = 3;

export const createPublishContentJob = (
  input: Readonly<{
    workspaceId: WorkspaceId;
    attemptId: string;
    availableAt?: Date;
  }>,
): EnqueueJobInput => ({
  name: "publish_content",
  payload: createPublishContentJobPayload(input),
  idempotencyKey: `publish-content:${input.attemptId}`,
  attemptPolicy: { maxAttempts: publishContentMaxAttempts },
  ...(input.availableAt ? { availableAt: input.availableAt } : {}),
});

/** The queue gives a reconcile job this many runs; paired with the handler's exponential
 *  backoff (capped at 15 min/attempt), this covers roughly 1.5-2 h of provider processing. */
export const reconcilePublicationMaxAttempts = 12;

export const createReconcilePublicationJob = (
  input: Readonly<{
    workspaceId: WorkspaceId;
    attemptId: string;
  }>,
): EnqueueJobInput => ({
  name: "reconcile_publication",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { attemptId: input.attemptId },
  }),
  idempotencyKey: `reconcile-publication:${input.attemptId}`,
  attemptPolicy: { maxAttempts: reconcilePublicationMaxAttempts },
});

// Two attempts: a worker that dies mid-render (deploy, OOM) leaves the job RUNNING until its
// lease expires, then it is claimed once more. A render error still records the ReelRender row
// as failed on the first attempt and the operator retries through render_reel (D5/D6 in the
// reel voice spec).
export const renderReelMaxAttempts = 2;

export const renderCreativesMaxAttempts = 2;

export const createRenderCreativesJob = (input: {
  workspaceId: WorkspaceId;
  contentItemId: string;
  attempt: number;
}): EnqueueJobInput => ({
  name: "render_creatives",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { contentItemId: input.contentItemId },
  }),
  idempotencyKey: `creative-render:${input.contentItemId}:${input.attempt}`,
  attemptPolicy: { maxAttempts: renderCreativesMaxAttempts },
});

export const createRenderReelJob = (
  input: Readonly<{ workspaceId: WorkspaceId; sourceVariantId: string; attempt: number }>,
): EnqueueJobInput => ({
  name: "render_reel",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { sourceVariantId: input.sourceVariantId },
  }),
  idempotencyKey: `render-reel:${input.sourceVariantId}:${input.attempt}`,
  attemptPolicy: { maxAttempts: renderReelMaxAttempts },
});

export const createRenderOwnedClipJob = (input: {
  workspaceId: WorkspaceId;
  assetId: string;
}): EnqueueJobInput => ({
  name: "render_owned_clip",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { assetId: input.assetId },
  }),
  idempotencyKey: `owned-clip-render:${input.assetId}`,
  attemptPolicy: { maxAttempts: 2 },
});

/** Offer ids are UUIDs (`createOffer` defaults to `crypto.randomUUID()`), as payload identifiers require. */
export const produceOfferPackageMaxAttempts = 6;

export const createProduceOfferPackageJob = (input: {
  workspaceId: WorkspaceId;
  offerId: string;
}): EnqueueJobInput => ({
  name: "produce_offer_package",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { offerId: input.offerId },
  }),
  idempotencyKey: `offer-package:${input.offerId}`,
  attemptPolicy: { maxAttempts: produceOfferPackageMaxAttempts },
});

/** Local-AI copy drafting for a packaged offer; one job per content item. */
export const createDraftOfferCopyJob = (input: {
  workspaceId: WorkspaceId;
  contentItemId: string;
}): EnqueueJobInput => ({
  name: "draft_offer_copy",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { contentItemId: input.contentItemId },
  }),
  idempotencyKey: `offer-copy:${input.contentItemId}`,
  attemptPolicy: { maxAttempts: 3 },
});

/**
 * Auto-package scenes (home: image_editing). `round` names the batch (`start`, or the first
 * slot and attempt it draws), so each batch and each regeneration is enqueued once.
 */
export const createGenerateOfferScenesJob = (input: {
  workspaceId: WorkspaceId;
  contentItemId: string;
  round: string;
}): EnqueueJobInput => ({
  name: "generate_offer_scenes",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { contentItemId: input.contentItemId },
  }),
  idempotencyKey: `offer-scenes:${input.contentItemId}:${input.round}`,
  attemptPolicy: { maxAttempts: 3 },
});

/** Automatic product fidelity check of one stored offer scene (home: visual_qa). */
export const createCheckSceneFidelityJob = (input: {
  workspaceId: WorkspaceId;
  assetId: string;
  /** Cut-out check (Phase 3): the canonical product asset is judged in this item's context. */
  contentItemId?: string;
}): EnqueueJobInput => ({
  name: "check_scene_fidelity",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: {
      assetId: input.assetId,
      ...(input.contentItemId ? { contentItemId: input.contentItemId } : {}),
    },
  }),
  idempotencyKey: `scene-fidelity:${input.assetId}`,
  attemptPolicy: { maxAttempts: 3 },
});

/** ASR check of a voiced Reel's narration against its script (home: speech_recognition). */
export const createCheckNarrationJob = (input: {
  workspaceId: WorkspaceId;
  sourceVariantId: string;
  assetId: string;
}): EnqueueJobInput => ({
  name: "check_narration",
  payload: parseVersionedIdentifierPayload({
    version: 1,
    workspaceId: input.workspaceId,
    identifiers: { sourceVariantId: input.sourceVariantId, assetId: input.assetId },
  }),
  idempotencyKey: `narration:${input.assetId}`,
  attemptPolicy: { maxAttempts: 3 },
});

export type QueuedJob = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  payload: JobIdentifierPayload;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
}>;

export type ClaimedJob = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  payload: unknown;
  leaseToken: string;
  idempotencyKey: string;
  attemptCount: number;
}>;

export interface JobQueue {
  enqueue(input: EnqueueJobInput): Promise<QueuedJob>;
  /** Claims only jobs whose name is in `names` (the caller's registered handlers). */
  claim(input: {
    workerId: string;
    leaseDurationMs: number;
    names: readonly string[];
    /** Only this workspace's jobs (home workers, ADR 0012); absent claims across workspaces. */
    workspaceId?: WorkspaceId;
    /** Claimed first when ready, before older jobs of other names (keeps a loaded model busy). */
    preferNames?: readonly string[];
  }): Promise<ClaimedJob | null>;
  /**
   * Takes over a live lease (ADR 0012): atomically swaps the lease token for a new one and
   * returns the job with it, so one posted result can act on a task only once.
   */
  takeLease?(input: {
    id: string;
    workspaceId: WorkspaceId;
    leaseToken: string;
  }): Promise<ClaimedJob | null>;
  complete(input: { id: string; workspaceId: WorkspaceId; leaseToken: string }): Promise<void>;
  retry(input: {
    id: string;
    workspaceId: WorkspaceId;
    leaseToken: string;
    reason: string;
    /** Delays the next claim until this time instead of the queue's default short backoff. */
    retryAt?: Date;
  }): Promise<void>;
  failPermanently(input: {
    id: string;
    workspaceId: WorkspaceId;
    leaseToken: string;
    reason: string;
  }): Promise<void>;
  /** Puts a terminally FAILED job back in the queue with fresh attempts; false if it is not FAILED. */
  revive?(input: { workspaceId: WorkspaceId; jobId: string }): Promise<boolean>;
}

/** Aborted with Error("render_timeout") past a heavy job's deadline, or Error("worker_shutdown"). */
export type JobContext = Readonly<{ signal: AbortSignal }>;

export type JobHandler = (
  job: Readonly<ClaimedJob & { payload: JobIdentifierPayload }>,
  context?: JobContext,
) => Promise<void>;

/**
 * CPU-heavy render jobs: the queue claims at most one of them at a time across every worker
 * process, and the worker puts a deadline on each.
 */
export const HEAVY_JOB_NAMES = ["render_reel", "render_long_form", "render_owned_clip"] as const;

/**
 * Model-server jobs for a home machine (v2 spec 17.4): claimed one at a time across every worker,
 * independently of the heavy renders, and only by a `local_ai` worker. Names only; the handlers
 * arrive with slices 26-28.
 */
export const LOCAL_AI_JOB_NAMES = [
  "direct_scenes",
  "review_frames",
  "generate_plates",
  "upscale_assets",
  "draft_offer_copy",
  "generate_clips",
  "generate_offer_scenes",
  "check_scene_fidelity",
  "check_narration",
] as const;

/** The abort reason a handler sees, if its job's signal was aborted by the worker. */
export const jobAbortReason = (
  signal: AbortSignal | undefined,
): "render_timeout" | "worker_shutdown" | undefined => {
  if (!signal?.aborted) return undefined;
  const message = signal.reason instanceof Error ? signal.reason.message : "";
  return message === "render_timeout" ? "render_timeout" : "worker_shutdown";
};

export class PermanentJobError extends Error {
  public constructor(public readonly reason = "unsupported_job") {
    super("The job cannot be retried.");
  }
}

/** A handler throws this to push its next attempt to a specific time, instead of the
 *  queue's default short backoff (e.g. while waiting on slow provider processing). */
/** The queue refused a transition: this worker's lease expired and another worker took the job. */
export class JobClaimLostError extends Error {
  public constructor() {
    super("Job claim is no longer active.");
    this.name = "JobClaimLostError";
  }
}

export class RetryLaterJobError extends Error {
  public readonly retryAt: Date;

  public constructor(message: string, retryAt: Date) {
    super(message);
    this.retryAt = retryAt;
  }
}

const identifierName = /^[a-z][a-zA-Z0-9]*$/;
const maximumIdentifierCount = 16;
const maximumIdentifierNameLength = 64;
const maximumPayloadBytes = 1_024;

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null && !Array.isArray(input);

const parsePayloadIdentifier = (input: unknown): WorkspaceId => {
  try {
    return parseWorkspaceId(input).toLowerCase() as WorkspaceId;
  } catch {
    throw new Error("Job payload identifiers must be valid UUIDs.");
  }
};

/**
 * Jobs carry only a versioned tenant identifier envelope. This boundary keeps
 * credentials and provider request bodies out of durable queue storage.
 */
export const parseVersionedIdentifierPayload = (input: unknown): JobIdentifierPayload => {
  if (!isRecord(input) || Object.keys(input).length !== 3) {
    throw new Error("Job payload must contain only version, workspaceId, and identifiers.");
  }
  if (input.version !== 1) {
    throw new Error("Job payload version is unsupported.");
  }
  const workspaceId = parsePayloadIdentifier(input.workspaceId);
  if (!isRecord(input.identifiers) || Object.keys(input.identifiers).length === 0) {
    throw new Error("Job payload identifiers must be a non-empty object.");
  }
  if (Object.keys(input.identifiers).length > maximumIdentifierCount) {
    throw new Error("Job payload has too many identifiers.");
  }
  const identifiers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.identifiers)) {
    if (name.length > maximumIdentifierNameLength) {
      throw new Error("Job payload identifier names are too long.");
    }
    if (!identifierName.test(name)) {
      throw new Error("Job payload identifier names must be camelCase.");
    }
    identifiers[name] = parsePayloadIdentifier(value);
  }
  const payload = { version: 1 as const, workspaceId, identifiers: Object.freeze(identifiers) };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maximumPayloadBytes) {
    throw new Error("Job payload is too large.");
  }
  return Object.freeze(payload);
};

type WorkerInput = Readonly<{
  queue: Pick<JobQueue, "claim" | "complete" | "retry" | "failPermanently">;
  handlers: Readonly<Record<string, JobHandler>>;
  workerId: string;
  leaseDurationMs: number;
  pollIntervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Called when the queue refuses a transition because another worker now owns the job. */
  onClaimLost?: (job: Readonly<{ id: string; name: string }>) => void;
  /** Deadline for HEAVY_JOB_NAMES jobs; absent means none. */
  heavyJobTimeoutMs?: number;
  /** Deadline for render_long_form only; absent falls back to heavyJobTimeoutMs. */
  longFormJobTimeoutMs?: number;
  /** Deadline for LOCAL_AI_JOB_NAMES jobs; absent means none. */
  localAiJobTimeoutMs?: number;
}>;

export type JobWorker = Readonly<{ requestStop: () => void; run: () => Promise<void> }>;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const heavyNames: readonly string[] = HEAVY_JOB_NAMES;
const localAiNames: readonly string[] = LOCAL_AI_JOB_NAMES;

/**
 * Runs jobs serially. A shutdown aborts the job in flight (its handler sees the signal, kills its
 * processes and cleans up) and hands it back to the queue for another worker.
 */
export const createWorker = (input: WorkerInput): JobWorker => {
  let stopRequested = false;
  let inFlight: AbortController | undefined;
  const requestStop = () => {
    stopRequested = true;
    inFlight?.abort(new Error("worker_shutdown"));
  };

  const names = Object.keys(input.handlers);

  const run = async (): Promise<void> => {
    while (!stopRequested) {
      const claimed = await input.queue.claim({
        workerId: input.workerId,
        leaseDurationMs: input.leaseDurationMs,
        names,
      });
      if (!claimed) {
        if (!stopRequested) await (input.sleep ?? defaultSleep)(input.pollIntervalMs);
        continue;
      }

      const controller = new AbortController();
      inFlight = controller;
      const timeoutMs = heavyNames.includes(claimed.name)
        ? claimed.name === "render_long_form"
          ? (input.longFormJobTimeoutMs ?? input.heavyJobTimeoutMs)
          : input.heavyJobTimeoutMs
        : localAiNames.includes(claimed.name)
          ? input.localAiJobTimeoutMs
          : undefined;
      const deadline =
        timeoutMs !== undefined
          ? setTimeout(() => controller.abort(new Error("render_timeout")), timeoutMs)
          : undefined;
      if (stopRequested) controller.abort(new Error("worker_shutdown"));
      try {
        try {
          const payload = parseVersionedIdentifierPayload(claimed.payload);
          const handler = Object.hasOwn(input.handlers, claimed.name)
            ? input.handlers[claimed.name]
            : undefined;
          if (!handler) throw new PermanentJobError();
          await handler({ ...claimed, payload }, { signal: controller.signal });
          if (jobAbortReason(controller.signal) === "render_timeout")
            throw new PermanentJobError("render_timeout");
          await input.queue.complete({
            id: claimed.id,
            workspaceId: claimed.workspaceId,
            leaseToken: claimed.leaseToken,
          });
        } catch (caught: unknown) {
          if (caught instanceof JobClaimLostError) throw caught;
          const aborted = jobAbortReason(controller.signal);
          const error =
            aborted === "render_timeout"
              ? new PermanentJobError("render_timeout")
              : aborted === "worker_shutdown" &&
                  !(caught instanceof PermanentJobError) &&
                  !(caught instanceof RetryLaterJobError)
                ? new Error("worker_shutdown")
                : caught;
          if (error instanceof PermanentJobError) {
            await input.queue.failPermanently({
              id: claimed.id,
              workspaceId: claimed.workspaceId,
              leaseToken: claimed.leaseToken,
              reason: error.reason,
            });
          } else if (error instanceof Error && error.message.startsWith("Job payload")) {
            await input.queue.failPermanently({
              id: claimed.id,
              workspaceId: claimed.workspaceId,
              leaseToken: claimed.leaseToken,
              reason: "malformed_payload",
            });
          } else if (error instanceof RetryLaterJobError) {
            await input.queue.retry({
              id: claimed.id,
              workspaceId: claimed.workspaceId,
              leaseToken: claimed.leaseToken,
              reason: error.message,
              retryAt: error.retryAt,
            });
          } else {
            await input.queue.retry({
              id: claimed.id,
              workspaceId: claimed.workspaceId,
              leaseToken: claimed.leaseToken,
              reason:
                error instanceof Error && error.message === "worker_shutdown"
                  ? "worker_shutdown"
                  : "handler_failed",
            });
          }
        }
      } catch (lost: unknown) {
        // The job's outcome now belongs to the worker that re-claimed it.
        if (!(lost instanceof JobClaimLostError)) throw lost;
        input.onClaimLost?.({ id: claimed.id, name: claimed.name });
      } finally {
        if (deadline) clearTimeout(deadline);
        inFlight = undefined;
      }
    }
  };

  return { requestStop, run };
};
