import { z } from "zod";

/**
 * Wire contract for one remote GPU job (spec 2026-10-09 cloud GPU pilot, phase P2). The remote
 * executor is untrusted: it gets short-lived object URLs and nothing else, so both schemas are
 * strict and carry no credential field.
 */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const httpsUrl = z.url({ protocol: /^https$/ });
const key = z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/);

export const REMOTE_GPU_OUTPUT_MIME_TYPES = ["video/mp4", "video/webm"] as const;

export const remoteGpuJobRequestSchema = z
  .object({
    jobId: z.uuid(),
    workspaceId: z.uuid(),
    operationKey: key,
    reservationId: z.uuid(),
    purpose: z.enum(["explainer_shot", "affiliate_hero"]),
    model: z.object({ id: key, revision: key }).strict(),
    prompt: z.string().min(1).max(4_000),
    negativePrompt: z.string().max(4_000),
    seed: z.number().int().min(0).max(2_147_483_646),
    clip: z
      .object({
        width: z.number().int().min(256).max(1920),
        height: z.number().int().min(256).max(1920),
        fps: z.number().int().min(8).max(30),
        seconds: z.literal(5),
      })
      .strict(),
    inputs: z
      .array(
        z
          .object({
            url: httpsUrl,
            sha256,
            mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          })
          .strict(),
      )
      .min(1)
      .max(4),
    output: z
      .object({ url: httpsUrl, maxBytes: z.number().int().min(1).max(100_000_000) })
      .strict(),
    deadline: z.iso.datetime(),
    attempt: z.number().int().min(1).max(3),
  })
  .strict();
export type RemoteGpuJobRequest = z.infer<typeof remoteGpuJobRequestSchema>;

export const remoteGpuJobResultSchema = z
  .object({
    jobId: z.uuid(),
    operationKey: key,
    provider: key,
    runId: key,
    model: z.object({ id: key, revision: key }).strict(),
    output: z
      .object({
        sha256,
        bytes: z.number().int().min(1),
        mimeType: z.enum(REMOTE_GPU_OUTPUT_MIME_TYPES),
        width: z.number().int(),
        height: z.number().int(),
        fps: z.number().int(),
        durationMs: z.number().int(),
      })
      .strict(),
    billing: z
      .object({
        currency: z.string().regex(/^[A-Z]{3}$/),
        minor: z.number().int().min(0),
        billedSeconds: z.number().min(0),
      })
      .strict(),
  })
  .strict();
export type RemoteGpuJobResult = z.infer<typeof remoteGpuJobResultSchema>;
