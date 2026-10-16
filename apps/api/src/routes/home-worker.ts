import { createHash } from "node:crypto";
import {
  COPY_CAPTION_MAX_CHARS,
  MAX_HOOK_OPTIONS,
  OFFER_COPY_SLIDE_RANGE,
  TEMPLATE_IDS,
} from "@money-maker/core/content/offer-copy";
import { MAX_VOICE_LINE_LENGTH } from "@money-maker/core/creatives/slide-spec";
import { VLM_ISSUE_KINDS } from "@money-maker/core/explainer/visual-qa/vlm-review";
import { createModelStreak } from "@money-maker/core/home-worker/model-streak";
import {
  applyHomeResult,
  claimHomeTask,
  failHomeTask,
  type HomeResult,
  MAX_PLATE_BYTES,
  MAX_SCENE_BYTES,
  OFFER_SCENES_PER_TASK,
  PLATES_PER_TASK,
} from "@money-maker/core/home-worker/tasks";
import {
  authenticateHomeWorker,
  HOME_CAPABILITIES,
  type HomeCapability,
  type HomeWorkerToken,
} from "@money-maker/core/home-worker/tokens";
import { MAX_TRANSCRIPT_LENGTH } from "@money-maker/core/publishing/narration-check";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDependencies } from "../app.js";
import { sendError, unexpectedError } from "../http/errors.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type TaskParams = { jobId: string };

/** Plates travel inline as base64 (ADR 0012), a few per task. */
const PLATE_BASE64_MAX = Math.ceil(MAX_PLATE_BYTES / 3) * 4;
const SCENE_BASE64_MAX = Math.ceil(MAX_SCENE_BYTES / 3) * 4;
const RESULT_BODY_LIMIT =
  // Each offer scene may carry a depth map of at most the same size.
  Math.max(PLATES_PER_TASK * PLATE_BASE64_MAX, OFFER_SCENES_PER_TASK * 2 * SCENE_BASE64_MAX) +
  1024 * 1024;
/** One scene clip per task, bounded by the configured LOCAL_AI_MAX_VIDEO_BYTES (<= 100 MB). */
const VIDEO_BASE64_MAX = Math.ceil(100_000_000 / 3) * 4;
const VIDEO_BODY_LIMIT = VIDEO_BASE64_MAX + 1024 * 1024;
/** Director plans and reviews are small; only image_generation/image_editing tokens send images. */
const SMALL_BODY_LIMIT = 1024 * 1024;
const VLM_FINDING_IDS = VLM_ISSUE_KINDS.map((kind) => `vlm_${kind}` as const);

const sha256 = async (plain: string) => createHash("sha256").update(plain).digest("hex");

const leaseSchema = z.object({ leaseToken: z.uuid() });
const findingSchema = z
  .object({
    id: z.enum(VLM_FINDING_IDS),
    severity: z.enum(["INFO", "WARN"]),
    sceneIndex: z.number().int().min(0).max(500),
    detail: z.string().max(140).optional(),
  })
  .strict();
const slideSchema = z
  .object({
    index: z.number().int().min(1).max(7),
    total: z.number().int().min(OFFER_COPY_SLIDE_RANGE.min).max(7),
    template: z.enum(TEMPLATE_IDS),
    headline: z.string().max(60),
    body: z.string().max(140).optional(),
    badge: z.string().max(40).optional(),
    voiceLine: z.string().max(MAX_VOICE_LINE_LENGTH).optional(),
    claims: z
      .array(
        z
          .object({
            text: z.string().trim().min(1).max(120),
            factKey: z.string().trim().min(1).max(200).optional(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
const captionSchema = z.string().max(COPY_CAPTION_MAX_CHARS).optional();
const provenanceSchema = z
  .object({
    runtime: z.string().min(1).max(80),
    observedModel: z.string().max(120).optional(),
    runtimeVersion: z.string().max(80).optional(),
  })
  .strict()
  .optional();
const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("draft_offer_copy"),
      draft: z
        .object({
          slides: z
            .array(slideSchema)
            .min(OFFER_COPY_SLIDE_RANGE.min)
            .max(OFFER_COPY_SLIDE_RANGE.max),
          captions: z
            .object({ instagram_carousel: captionSchema, threads: captionSchema })
            .strict(),
          hookOptions: z
            .array(
              z
                .object({
                  headline: z.string().max(60),
                  captionFirstLine: z.string().max(200),
                })
                .strict(),
            )
            .max(MAX_HOOK_OPTIONS)
            .optional(),
        })
        .strict(),
      // Raw art-director output, bounded here; core validates each line against its shot.
      sceneLines: z
        .object({
          lines: z
            .array(
              z
                .object({ index: z.number().int().min(1).max(12), scene: z.string().max(1000) })
                .strict(),
            )
            .max(12),
        })
        .strict()
        .optional(),
      model: z.string().min(1).max(120),
      provenance: z
        .object({
          runtime: z.string().min(1).max(80),
          observedModel: z.string().max(120).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("direct_scenes"), scenes: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal("generate_offer_scenes"),
      scenes: z
        .array(
          z
            .object({
              key: z.string().regex(/^\d{1,2}:(feed|story)$/),
              base64: z.string().min(1).max(SCENE_BASE64_MAX),
              model: z.string().min(1).max(120),
              seed: z.number().int().min(0).max(2_147_483_646),
              provenance: provenanceSchema,
              depthBase64: z.string().min(1).max(SCENE_BASE64_MAX).optional(),
              promptSha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(OFFER_SCENES_PER_TASK),
    })
    .strict(),
  // The VLM answer is validated strictly by core (parseVlmFidelityAnswer); a bad one retries.
  z
    .object({
      kind: z.literal("check_scene_fidelity"),
      answer: z.unknown(),
      model: z.string().min(1).max(120),
      provenance: provenanceSchema,
    })
    .strict(),
  // Raw ASR text only; the server compares it with the script and allowlists the model.
  z
    .object({
      kind: z.literal("check_narration"),
      transcript: z.string().max(MAX_TRANSCRIPT_LENGTH),
      model: z.string().min(1).max(120),
      provenance: provenanceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("generate_clips"),
      sceneIndex: z.number().int().min(0).max(500),
      base64: z.string().min(1).max(VIDEO_BASE64_MAX),
      mimeType: z.enum(["video/mp4", "video/webm"]),
      model: z.string().min(1).max(120),
      provenance: z
        .object({
          runtime: z.string().min(1).max(80),
          observedModel: z.string().max(120).optional(),
          runtimeVersion: z.string().max(80).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("generate_plates"),
      plates: z
        .array(
          z
            .object({
              key: z.string().min(1).max(200),
              base64: z.string().min(1).max(PLATE_BASE64_MAX),
              model: z.string().min(1).max(120),
              seed: z
                .number()
                .int()
                .min(0)
                .max(2 ** 32)
                .optional(),
              provenance: z
                .object({
                  runtime: z.string().min(1).max(80),
                  observedModel: z.string().max(120).optional(),
                  runtimeVersion: z.string().max(80).optional(),
                })
                .strict()
                .optional(),
            })
            .strict(),
        )
        .min(1)
        .max(PLATES_PER_TASK),
    })
    .strict(),
  z
    .object({
      kind: z.literal("review_frames"),
      review: z
        .object({
          record: z
            .object({
              vlm: z.enum(["reviewed", "skipped"]),
              reason: z.string().max(200).optional(),
              model: z.string().max(120).optional(),
              latencyMs: z.number().int().min(0).optional(),
              frames: z.number().int().min(0).max(500).optional(),
              unreadableFrames: z.number().int().min(0).max(500).optional(),
            })
            .strict(),
          findings: z.array(findingSchema).max(200),
        })
        .strict(),
    })
    .strict(),
]);
const resultBodySchema = leaseSchema
  .extend({
    result: resultSchema,
    workerVersion: z
      .string()
      .regex(/^[\w.+-]{1,40}$/)
      .optional(),
  })
  .strict();
const failBodySchema = leaseSchema
  .extend({ reason: z.string().trim().min(1).max(200), retryable: z.boolean() })
  .strict();

const HEARTBEAT_BODY_LIMIT = 2048;
const capabilitySchema = z.enum(HOME_CAPABILITIES);
const heartbeatSchema = z
  .object({
    capabilities: z.array(capabilitySchema).max(HOME_CAPABILITIES.length),
    busy: capabilitySchema.nullable(),
    runtimes: z.partialRecord(
      capabilitySchema,
      z.enum(["stopped", "starting", "healthy", "failed"]),
    ),
    lastCompletedAt: z.iso.datetime().nullable(),
    lastFailureCode: z
      .string()
      .regex(/^[a-z0-9_:.-]{1,80}$/)
      .nullable(),
  })
  .strict();

const toHomeResult = (result: z.infer<typeof resultSchema>): HomeResult => {
  // JSON has no undefined, so parsed optional fields are absent keys, never undefined values.
  if (result.kind === "generate_clips") {
    const { base64, ...rest } = result;
    return {
      ...rest,
      bytes: new Uint8Array(Buffer.from(base64, "base64")),
    } as unknown as HomeResult;
  }
  if (result.kind === "generate_offer_scenes")
    return {
      kind: "generate_offer_scenes",
      scenes: result.scenes.map(({ base64, depthBase64, ...scene }) => ({
        ...scene,
        bytes: new Uint8Array(Buffer.from(base64, "base64")),
        ...(depthBase64 ? { depth: new Uint8Array(Buffer.from(depthBase64, "base64")) } : {}),
      })),
    } as unknown as HomeResult;
  if (result.kind !== "generate_plates") return result as unknown as HomeResult;
  return {
    kind: "generate_plates",
    plates: result.plates.map((plate) => ({
      key: plate.key,
      bytes: new Uint8Array(Buffer.from(plate.base64, "base64")),
      model: plate.model,
      ...(plate.seed !== undefined ? { seed: plate.seed } : {}),
      ...(plate.provenance
        ? {
            provenance: {
              runtime: plate.provenance.runtime,
              ...(plate.provenance.observedModel !== undefined
                ? { observedModel: plate.provenance.observedModel }
                : {}),
              ...(plate.provenance.runtimeVersion !== undefined
                ? { runtimeVersion: plate.provenance.runtimeVersion }
                : {}),
            },
          }
        : {}),
    })),
  };
};

const bearer = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
};

/**
 * Home worker task API (ADR 0012). A home machine authenticates with its home worker token,
 * claims one local-AI task of its workspace, and posts the model output; the server validates
 * and writes. The token is checked in onRequest, before any body is read; the hook is scoped
 * to this plugin, so it guards only these routes.
 */
export const registerHomeWorkerRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  const homeWorker = options.dependencies.homeWorker;
  if (!homeWorker) return;
  // Jev is wired only when JEV_ENABLED with a key (server.ts); it picks among validated hooks.
  const { decisionProvider, audit } = options.dependencies;
  const tasks =
    decisionProvider && audit
      ? { ...homeWorker.tasks, decisions: { provider: decisionProvider, audit } }
      : homeWorker.tasks;
  const tokens = new WeakMap<FastifyRequest, HomeWorkerToken>();

  app.addHook("onRequest", async (request, reply) => {
    const token = await authenticateHomeWorker(
      homeWorker.tokens,
      { hash: sha256, now: () => new Date() },
      bearer(request),
    );
    if (!token)
      return sendError(reply, 401, {
        code: "UNAUTHENTICATED",
        message: "A valid home worker token is required",
      });
    tokens.set(request, token);
  });
  const tokenOf = (request: FastifyRequest): HomeWorkerToken => {
    const token = tokens.get(request);
    if (!token) throw new Error("Home worker token missing after authentication.");
    return token;
  };

  // One result upload per token at a time, sized by what the token may send, checked before the
  // body is read. ponytail: in-process set, one API instance; move to the database if scaled out.
  const uploading = new Set<string>();
  const holders = new WeakSet<FastifyRequest>();
  const admitResult = async (request: FastifyRequest, reply: FastifyReply) => {
    const token = tokenOf(request);
    const limit = token.capabilities.includes("video_generation")
      ? VIDEO_BODY_LIMIT
      : token.capabilities.includes("image_generation") ||
          token.capabilities.includes("image_editing")
        ? RESULT_BODY_LIMIT
        : SMALL_BODY_LIMIT;
    const length = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(length))
      return sendError(reply, 411, { code: "LENGTH_REQUIRED", message: "Content-Length required" });
    if (length > limit)
      return sendError(reply, 413, { code: "PAYLOAD_TOO_LARGE", message: "Result too large" });
    if (uploading.has(token.id))
      return sendError(reply, 429, { code: "TOO_MANY_REQUESTS", message: "One result at a time" });
    uploading.add(token.id);
    holders.add(request);
  };
  const releaseResult = async (request: FastifyRequest) => {
    if (holders.has(request)) uploading.delete(tokenOf(request).id);
  };

  const preferLoaded = createModelStreak();
  app.post<{ Body: unknown }>("/v1/home-worker/claim", async (request, reply) => {
    // Optional: the model the machine has loaded, so its jobs go first. Anything else is ignored.
    const loaded = z.object({ loaded: capabilitySchema }).safeParse(request.body ?? {})
      .data?.loaded;
    try {
      const token = tokenOf(request);
      const task = await claimHomeTask(homeWorker.tasks, token, 5, preferLoaded(token.id, loaded));
      if (!task) return reply.code(204).send();
      return reply.send({ task });
    } catch (error) {
      request.log.error({ err: error }, "home_worker_claim_failed");
      return unexpectedError(reply);
    }
  });

  // Liveness and runtime state only; stored for the capabilities this token actually has.
  app.post<{ Body: unknown }>(
    "/v1/home-worker/heartbeat",
    { bodyLimit: HEARTBEAT_BODY_LIMIT },
    async (request, reply) => {
      const body = heartbeatSchema.safeParse(request.body);
      if (!body.success)
        return sendError(reply, 400, { code: "INVALID_REQUEST", message: "Invalid heartbeat" });
      const token = tokenOf(request);
      const owned = (capability: HomeCapability) => token.capabilities.includes(capability);
      try {
        await homeWorker.tokens.recordHeartbeat({
          id: token.id,
          at: new Date(),
          heartbeat: {
            capabilities: [...new Set(body.data.capabilities)].filter(owned),
            busy: body.data.busy && owned(body.data.busy) ? body.data.busy : null,
            runtimes: Object.fromEntries(
              Object.entries(body.data.runtimes).filter(([key]) => owned(key as HomeCapability)),
            ),
            lastCompletedAt: body.data.lastCompletedAt,
            lastFailureCode: body.data.lastFailureCode,
          },
        });
        return reply.code(204).send();
      } catch (error) {
        request.log.error({ err: error }, "home_worker_heartbeat_failed");
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: unknown }>(
    "/v1/home-worker/tasks/:jobId/result",
    {
      bodyLimit: Math.max(RESULT_BODY_LIMIT, VIDEO_BODY_LIMIT),
      onRequest: admitResult,
      onResponse: releaseResult,
      onRequestAbort: releaseResult,
    },
    async (request, reply) => {
      const jobId = z.uuid().safeParse(request.params.jobId);
      const body = resultBodySchema.safeParse(request.body);
      if (!jobId.success || !body.success)
        return sendError(reply, 400, { code: "INVALID_REQUEST", message: "Invalid result" });
      try {
        const outcome = await applyHomeResult(tasks, tokenOf(request), {
          jobId: jobId.data,
          leaseToken: body.data.leaseToken,
          result: toHomeResult(body.data.result),
          workerVersion: body.data.workerVersion,
        });
        if (outcome.ok) return reply.send({ ok: true });
        if (outcome.reason === "task_not_leased")
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Task not found" });
        return sendError(reply, 422, { code: "RESULT_REJECTED", message: outcome.reason });
      } catch (error) {
        request.log.error({ err: error, jobId: jobId.data }, "home_worker_result_failed");
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: TaskParams; Body: unknown }>(
    "/v1/home-worker/tasks/:jobId/fail",
    async (request, reply) => {
      const jobId = z.uuid().safeParse(request.params.jobId);
      const body = failBodySchema.safeParse(request.body);
      if (!jobId.success || !body.success)
        return sendError(reply, 400, { code: "INVALID_REQUEST", message: "Invalid failure" });
      try {
        const outcome = await failHomeTask(homeWorker.tasks, tokenOf(request), {
          jobId: jobId.data,
          ...body.data,
        });
        if (outcome.ok) return reply.send({ ok: true });
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Task not found" });
      } catch (error) {
        request.log.error({ err: error, jobId: jobId.data }, "home_worker_fail_failed");
        return unexpectedError(reply);
      }
    },
  );
};
