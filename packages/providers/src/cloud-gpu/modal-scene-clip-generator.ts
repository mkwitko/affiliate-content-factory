import { createHash, randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  type RemoteGpuJobRequest,
  remoteGpuJobRequestSchema,
  remoteGpuJobResultSchema,
} from "@money-maker/contracts/cloud-gpu-job";
import {
  type SceneClipGenerator,
  SceneClipSubmitError,
} from "@money-maker/core/assets/scene-clip-generator";
import {
  type ModalShape,
  modalMeteredMinor,
  modalQuote,
} from "@money-maker/core/cloud-gpu/modal-quote";
import type {
  BudgetPolicy,
  GenerationBudgetLedger,
  ReserveResult,
} from "@money-maker/core/costs/generation-budget";
import type { R2SigningClient } from "../storage/r2-asset-store.js";
import type { PtaxRate } from "./ptax.js";

/**
 * Modal image-to-video behind the existing SceneClipGenerator port (generate_scene_clips job, R2
 * stage cache, checkSceneClip QA). Paid path, so every submit first reserves the worst case in the
 * budget ledger; any outcome it cannot prove ends `unresolved` (blocks further paid runs until
 * `cloud-budget reconcile`). Every failure is non-retryable: one attempt per scene, and the
 * handler falls back to the local static plate clip.
 */
/**
 * The deployed pilot function. Must match scripts/cloud-gpu/modal/modal_i2v.py (GPU, timeout,
 * model revision); the budget prices this shape. Worst case R$4.62 at PTAX 4.99; the R$5 cap
 * refuses it once the dollar passes about R$5.41. H100 does not fit (modal-quote.test.ts).
 */
export const MODAL_PILOT = {
  app: "money-maker-i2v",
  functionName: "generate_clip",
  shape: {
    gpu: "A100-80GB",
    cpuCores: 4,
    // No CPU offload (32 GiB). One hour is the ceiling the budget prices; the first deployed
    // function timed out at 600 s. The real run bills only its seconds (modalMeteredMinor).
    memoryGiB: 32,
    timeoutSeconds: 3600,
    coldStartSeconds: 240,
  },
  model: { id: "wan2.2-i2v-a14b", revision: "596658fd9ca6b7b71d5057529bbf319ecbc61d74" },
  cacheVersion: "modal:wan2.2-i2v-a14b@596658fd9ca6",
} as const satisfies Readonly<{
  app: string;
  functionName: string;
  shape: ModalShape;
  model: Readonly<{ id: string; revision: string }>;
  cacheVersion: string;
}>;

export type ModalCalls = Readonly<{
  spawn(request: RemoteGpuJobRequest): Promise<string>;
  /** `pending` while the call has not finished; `error` when the function raised. */
  result(
    callId: string,
  ): Promise<
    | Readonly<{ status: "pending" }>
    | Readonly<{ status: "done"; value: unknown }>
    | Readonly<{ status: "error" }>
  >;
  cancel(callId: string): Promise<void>;
}>;

export type ClipObjectStore = Readonly<{
  uploadUrl(key: string, expiresInSeconds: number): Promise<string>;
  downloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  /** Null when missing or larger than maxBytes. */
  read(key: string, maxBytes: number): Promise<Uint8Array | null>;
}>;

export type ModalSceneClipOptions = Readonly<{
  calls: ModalCalls;
  store: ClipObjectStore;
  ledger: GenerationBudgetLedger;
  /** Tried in order (free credit, then the paid month); the first that admits the run pays for it. */
  policies: readonly BudgetPolicy[];
  shape: ModalShape;
  model: Readonly<{ id: string; revision: string }>;
  fx: () => Promise<PtaxRate | null>;
  maxBytes?: number;
  /** Extra wait for a queued call before it is declared lost. */
  queueGraceSeconds?: number;
  now?: () => Date;
}>;

type Task = Readonly<{
  w: string;
  o: string;
  c: string;
  k: string;
  j: string;
  e: number;
}>;
const encode = (task: Task) => `mm1.${Buffer.from(JSON.stringify(task)).toString("base64url")}`;
const decode = (id: string): Task | null => {
  if (!id.startsWith("mm1.")) return null;
  try {
    const task = JSON.parse(Buffer.from(id.slice(4), "base64url").toString("utf8")) as Task;
    return typeof task.w === "string" && typeof task.c === "string" && Number.isInteger(task.e)
      ? task
      : null;
  } catch {
    return null;
  }
};
const refuse = (code: string): never => {
  throw new SceneClipSubmitError(code, false);
};

export const createModalSceneClipGenerator = (
  options: ModalSceneClipOptions,
): SceneClipGenerator => {
  const now = options.now ?? (() => new Date());
  const maxBytes = options.maxBytes ?? 50_000_000;
  const lifetimeSeconds =
    options.shape.timeoutSeconds +
    options.shape.coldStartSeconds +
    (options.queueGraceSeconds ?? 600);
  const taskModel = `modal:${options.model.id}@${options.model.revision.slice(0, 12)}`;
  const quotedUsdMinor = modalMeteredMinor(options.shape, options.shape.timeoutSeconds);

  return {
    async submit(request) {
      const budget = request.budget ?? refuse("modal_budget_context_missing");
      const [referenceUrl] = request.referenceImageUrls ?? [];
      const [referenceChecksum] = request.referenceChecksums ?? [];
      if (request.mode !== "image" || !referenceUrl || !referenceChecksum?.startsWith("sha256:"))
        refuse("modal_reference_required");
      if (request.seconds < 4 || request.seconds > 6) refuse("modal_duration_unsupported");
      const fx = await options.fx();
      if (!fx) return refuse("budget_fx_unavailable");
      const key = { workspaceId: budget.workspaceId, operationKey: budget.operationKey };
      const quote = modalQuote({
        shape: options.shape,
        model: options.model.id,
        revision: options.model.revision,
        fx,
        now: now(),
      });
      let reserved: ReserveResult = { status: "rejected", reason: "provider_unsupported" };
      for (const policy of options.policies) {
        reserved = await options.ledger.reserve({
          ...key,
          operation: "scene_clip:i2v_5s",
          quote,
          policy,
          now: now(),
        });
        if (reserved.status !== "rejected") break;
      }
      if (reserved.status === "rejected") return refuse(`budget_${reserved.reason}`);
      const outputKey = `workspaces/${budget.workspaceId}/cloud-gpu/${createHash("sha256")
        .update(budget.operationKey)
        .digest("hex")}.mp4`;
      if (reserved.status === "duplicate") {
        // A crash between spawn and the handler's save: resume the call instead of paying again.
        const runRef = reserved.reservation.receipt;
        if (reserved.reservation.status !== "reserved" || !runRef?.startsWith("modal:"))
          return refuse("budget_duplicate_operation");
        return {
          providerTaskId: encode({
            w: budget.workspaceId,
            o: budget.operationKey,
            c: runRef.slice("modal:".length),
            k: outputKey,
            j: "resumed",
            e: reserved.reservation.estimatedMinor,
          }),
          model: taskModel,
        };
      }
      const jobId = randomUUID();
      const parsed = remoteGpuJobRequestSchema.safeParse({
        jobId,
        workspaceId: budget.workspaceId,
        operationKey: budget.operationKey,
        reservationId: reserved.reservation.id,
        purpose: "explainer_shot",
        model: options.model,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        seed:
          request.seed ??
          createHash("sha256").update(request.prompt).digest().readUInt32BE(0) % 2_147_483_647,
        clip: { width: request.width, height: request.height, fps: 16, seconds: 5 },
        inputs: [
          {
            url: referenceUrl,
            sha256: referenceChecksum?.slice("sha256:".length),
            mimeType: "image/png",
          },
        ],
        output: { url: await options.store.uploadUrl(outputKey, lifetimeSeconds), maxBytes },
        deadline: new Date(now().getTime() + lifetimeSeconds * 1000).toISOString(),
        attempt: 1,
      });
      if (!parsed.success) {
        await options.ledger.release(key);
        return refuse("modal_request_invalid");
      }
      let callId: string;
      try {
        callId = await options.calls.spawn(parsed.data);
      } catch {
        // The call may exist without us knowing its id: hold the reservation as unknown.
        await options.ledger.markUnknown(key);
        return refuse("modal_spawn_unknown");
      }
      await options.ledger.recordRun({ ...key, runRef: `modal:${callId}` });
      return {
        providerTaskId: encode({
          w: budget.workspaceId,
          o: budget.operationKey,
          c: callId,
          k: outputKey,
          j: jobId,
          e: reserved.reservation.estimatedMinor,
        }),
        model: taskModel,
        submittedAt: now().toISOString(),
      };
    },

    async poll(task) {
      const decoded = decode(task.providerTaskId);
      if (!decoded) return { status: "failed", code: "modal_task_invalid", retryable: false };
      const key = { workspaceId: parseWorkspaceId(decoded.w), operationKey: decoded.o };
      const lost = async (code: string) => {
        await options.ledger.markUnknown(key);
        return { status: "failed" as const, code, retryable: false };
      };
      const outcome = await options.calls.result(decoded.c);
      if (outcome.status === "pending") {
        const started = task.submittedAt ? Date.parse(task.submittedAt) : Number.NaN;
        if (Number.isNaN(started) || now().getTime() - started <= lifetimeSeconds * 1000)
          return { status: "pending" };
        await options.calls.cancel(decoded.c).catch(() => undefined);
        return lost("modal_timeout");
      }
      if (outcome.status === "error") return lost("modal_failed");
      const result = remoteGpuJobResultSchema.safeParse(outcome.value);
      if (
        !result.success ||
        result.data.operationKey !== decoded.o ||
        (decoded.j !== "resumed" && result.data.jobId !== decoded.j) ||
        result.data.provider !== "modal" ||
        result.data.model.id !== options.model.id ||
        result.data.model.revision !== options.model.revision
      )
        return lost("modal_result_invalid");
      const metered = modalMeteredMinor(options.shape, result.data.billing.billedSeconds);
      await options.ledger.settle({
        ...key,
        actualMinor: Math.min(decoded.e, Math.ceil((decoded.e * metered) / quotedUsdMinor)),
        receipt: `modal:${decoded.c}:metered-estimate`,
      });
      // Billed from here on: a bad file falls back, the spend stays recorded.
      const bytes = await options.store.read(decoded.k, maxBytes);
      if (!bytes) return { status: "failed", code: "modal_output_missing", retryable: false };
      if (
        bytes.byteLength !== result.data.output.bytes ||
        createHash("sha256").update(bytes).digest("hex") !== result.data.output.sha256
      )
        return { status: "failed", code: "modal_output_checksum", retryable: false };
      return { status: "completed", url: await options.store.downloadUrl(decoded.k, 900) };
    },
  };
};

/** The production object store: presigned R2 URLs, bounded reads. */
export const createR2ClipObjectStore = (
  signing: Pick<R2SigningClient, "createUploadUrl" | "createDownloadUrl">,
  doFetch: typeof fetch = fetch,
): ClipObjectStore => ({
  uploadUrl: (key, expiresInSeconds) =>
    signing.createUploadUrl({ key, contentType: "video/mp4", metadata: {}, expiresInSeconds }),
  downloadUrl: (key, expiresInSeconds) => signing.createDownloadUrl({ key, expiresInSeconds }),
  read: async (key, maxBytes) => {
    const url = await signing.createDownloadUrl({ key, expiresInSeconds: 300 });
    const response = await doFetch(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
    if (!response.ok) return null;
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maxBytes ? bytes : null;
  },
});

/** The production Modal client (official SDK); credentials come from the worker environment. */
export const createModalCalls = (options: {
  /** Absent: the SDK reads the local Modal profile (~/.modal.toml), for owner-run trials. */
  token?: Readonly<{ id: string; secret: string }>;
  app: string;
  functionName: string;
}): ModalCalls => {
  const load = async () => {
    const sdk = await import("modal");
    return {
      sdk,
      client: new sdk.ModalClient(
        options.token ? { tokenId: options.token.id, tokenSecret: options.token.secret } : {},
      ),
    };
  };
  let loaded: ReturnType<typeof load> | undefined;
  const modal = () => {
    loaded ??= load();
    return loaded;
  };
  return {
    async spawn(request) {
      const { client } = await modal();
      const fn = await client.functions.fromName(options.app, options.functionName);
      return (await fn.spawn([request])).functionCallId;
    },
    async result(callId) {
      const { sdk, client } = await modal();
      const call = await client.functionCalls.fromId(callId);
      try {
        return { status: "done", value: await call.get({ timeoutMs: 1_000 }) };
      } catch (error) {
        if (error instanceof sdk.FunctionTimeoutError) return { status: "pending" };
        if (
          error instanceof sdk.RemoteError ||
          error instanceof sdk.InternalFailure ||
          error instanceof sdk.ExecutionError
        )
          return { status: "error" };
        throw error; // a network blip: the job retries the poll later, nothing is resubmitted
      }
    },
    async cancel(callId) {
      const { client } = await modal();
      await (await client.functionCalls.fromId(callId)).cancel({ terminateContainers: true });
    },
  };
};

export type ModalCredentials = Readonly<{ tokenId: string; tokenSecret: string }>;

/**
 * Checks a Modal token before it is stored: a bad token must never reach spawn, where a failure
 * marks the reservation unknown and blocks paid runs. NotFound means the token works and the pilot
 * app is not deployed yet.
 */
export const verifyModalCredentials = async (
  credentials: ModalCredentials,
  lookup: (credentials: ModalCredentials) => Promise<void> = async ({ tokenId, tokenSecret }) => {
    const sdk = await import("modal");
    const client = new sdk.ModalClient({ tokenId, tokenSecret });
    await client.functions.fromName(MODAL_PILOT.app, MODAL_PILOT.functionName);
  },
  isNotFound: (error: unknown) => Promise<boolean> = async (error) =>
    error instanceof (await import("modal")).NotFoundError,
): Promise<"deployed" | "app_missing" | "invalid"> => {
  try {
    await lookup(credentials);
    return "deployed";
  } catch (error) {
    return (await isNotFound(error)) ? "app_missing" : "invalid";
  }
};
