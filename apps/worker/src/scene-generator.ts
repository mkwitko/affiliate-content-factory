import type { WorkerEnvironment } from "@money-maker/config";
import {
  cloudGenerationAllowed,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import { createWorkersAiSceneGenerator } from "@money-maker/providers/cloudflare/workers-ai-scene-generator";
import { createCommandSceneGenerator } from "@money-maker/providers/media/command-scene-generator";

/**
 * A local command on a home machine first, then Workers AI FLUX.1 schnell (the default, free
 * tier; never under GENERATION_POLICY=local_only), else none (the scene bank then reuses its pool or falls back to procedural scenes).
 */
export const sceneGeneratorFor = (
  environment: Pick<
    WorkerEnvironment,
    | "SCENE_GENERATOR_CMD"
    | "SCENE_GENERATOR_MODEL"
    | "WORKER_MACHINE_KIND"
    | "CLOUDFLARE_ACCOUNT_ID"
    | "CLOUDFLARE_API_TOKEN"
    | "CLOUDFLARE_AI_GATEWAY"
  > &
    Partial<Pick<WorkerEnvironment, "GENERATION_POLICY">>,
): SceneGenerator | null =>
  environment.SCENE_GENERATOR_CMD && environment.SCENE_GENERATOR_MODEL
    ? createCommandSceneGenerator({
        command: environment.SCENE_GENERATOR_CMD,
        model: environment.SCENE_GENERATOR_MODEL,
        machineKind: environment.WORKER_MACHINE_KIND,
      })
    : environment.GENERATION_POLICY !== "local_only" &&
        environment.CLOUDFLARE_ACCOUNT_ID &&
        environment.CLOUDFLARE_API_TOKEN &&
        environment.CLOUDFLARE_AI_GATEWAY
      ? createWorkersAiSceneGenerator({
          accountId: environment.CLOUDFLARE_ACCOUNT_ID,
          apiToken: environment.CLOUDFLARE_API_TOKEN,
          gateway: environment.CLOUDFLARE_AI_GATEWAY,
        })
      : null;

/** The hosted Agnes clip key, withheld under `local_only` so scene_clips never becomes available. */
export const agnesApiKeyFor = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined =>
  cloudGenerationAllowed(parseGenerationPolicy(env.GENERATION_POLICY))
    ? env.AGNES_API_KEY
    : undefined;

/**
 * Local Wan clips: LOCAL_VIDEO_ENABLED and a video model that model policy has promoted. Wan ships
 * disabled, so this stays false until the owner flips it after the benchmark.
 */
export const localVideoFor = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const policy = modelPolicyFor(env.VIDEO_GEN_MODEL?.trim() || "local:wan2.2-ti2v-5b");
  return (
    env.LOCAL_VIDEO_ENABLED === "true" &&
    policy?.capability === "video_generation" &&
    policy.enabled
  );
};

/**
 * Modal pilot clips (spec 2026-10-09 cloud GPU pilot): only when the owner lists `modal` in
 * CLOUD_GPU_PROVIDERS and the Modal token is set, and never under `local_only`. The same list
 * enables the provider in the budget policy, so one setting turns paid clips on or off.
 */
export const cloudGpuProvidersFor = (
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] =>
  cloudGenerationAllowed(parseGenerationPolicy(env.GENERATION_POLICY))
    ? (env.CLOUD_GPU_PROVIDERS ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name === "modal")
    : [];
