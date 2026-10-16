import { cloudGenerationAllowed, type GenerationPolicy } from "../assets/generation-policy.js";

/** Capability health model: pure. Probes live elsewhere (the doctor command) and are injected as observations. */
export const CAPABILITY_IDS = [
  "scene_direction",
  "copywriting",
  "image_generation",
  "image_editing",
  "video_generation",
  "visual_review",
  "tts",
  "upscale",
  "stickman_render",
  "hyperframes_render",
  "publishing",
  "mercado_livre_research",
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type BackendState =
  | "ok"
  | "disabled"
  | "unconfigured"
  | "offline"
  | "policy_blocked"
  | "experimental";
/** What a probe saw. `ok` means reachable and configured; policy and experiments are applied by evaluateCapabilities. */
export type Observation = Readonly<{
  state: "ok" | "disabled" | "unconfigured" | "offline";
  reason?: string;
}>;

type BackendSpec = Readonly<{
  id: string;
  /** Needs a hosted provider: blocked under GENERATION_POLICY=local_only. */
  cloud?: boolean;
  /** Never chosen automatically; reported as experimental when it works. */
  experimental?: boolean;
  /** Needs no probe (procedural or static fallbacks). */
  always?: boolean;
  /** Fixed honest state when nothing can observe it yet. */
  fixed?: Observation;
}>;

/** Ordered by CURRENT routing; changing this table does not change routing, it only reports it. */
export const CAPABILITY_BACKENDS: Readonly<Record<CapabilityId, readonly BackendSpec[]>> = {
  scene_direction: [
    { id: "local:scene-director" },
    { id: "home_worker:scene_director" },
    // No automatic fallback exists: without a director, an operator writes the storyboard.
    { id: "operator_via_mcp", fixed: { state: "ok", reason: "manual: create_video_storyboard" } },
  ],
  copywriting: [
    { id: "local:copywriter" },
    { id: "home_worker:copywriting" },
    // No template copy exists: without a local model, an operator writes slides and captions.
    { id: "operator_via_mcp", fixed: { state: "ok", reason: "manual: build_post_creatives" } },
  ],
  image_generation: [
    { id: "home_worker:sd.cpp", experimental: true },
    { id: "local:command_generator" },
    { id: "workers_ai:flux-1-schnell", cloud: true },
    { id: "scene_bank_reuse", always: true },
    { id: "procedural", always: true },
  ],
  // Auto-package scenes (generate_offer_scenes); without it the cut-out render is used.
  image_editing: [{ id: "home_worker:image_editing" }],
  video_generation: [
    { id: "local:wan2.2-ti2v-5b" },
    { id: "agnes_hosted", cloud: true, experimental: true },
    { id: "stickman_static_fallback", always: true },
  ],
  visual_review: [
    { id: "local:qwen-vl" },
    { id: "home_worker:visual_qa" },
    { id: "deterministic_checks", always: true },
  ],
  tts: [{ id: "local:kokoro" }],
  upscale: [{ id: "local:realesrgan-ncnn-vulkan" }],
  stickman_render: [{ id: "ffmpeg_svg_motion" }],
  hyperframes_render: [{ id: "hyperframes_cli", experimental: true }],
  publishing: [{ id: "post_for_me" }],
  mercado_livre_research: [{ id: "mercado_livre" }],
};

export type BackendHealth = Readonly<{ id: string; state: BackendState; reason: string }>;
export type CapabilityHealth = Readonly<{
  capability: CapabilityId;
  active: string | null;
  backends: readonly BackendHealth[];
}>;

const evaluateBackend = (
  spec: BackendSpec,
  observations: Readonly<Record<string, Observation | undefined>>,
  policy: GenerationPolicy,
): BackendHealth => {
  if (spec.cloud && !cloudGenerationAllowed(policy))
    return { id: spec.id, state: "policy_blocked", reason: "GENERATION_POLICY=local_only" };
  if (spec.always) return { id: spec.id, state: "ok", reason: "always available" };
  const seen = spec.fixed ?? observations[spec.id] ?? { state: "unconfigured" as const };
  if (seen.state === "ok" && spec.experimental)
    return { id: spec.id, state: "experimental", reason: seen.reason ?? "experimental" };
  return { id: spec.id, state: seen.state, reason: seen.reason ?? seen.state };
};

export const evaluateCapabilities = (
  observations: Readonly<Record<string, Observation | undefined>>,
  policy: GenerationPolicy,
): readonly CapabilityHealth[] =>
  CAPABILITY_IDS.map((capability) => {
    const backends = CAPABILITY_BACKENDS[capability].map((spec) =>
      evaluateBackend(spec, observations, policy),
    );
    return {
      capability,
      active: backends.find((backend) => backend.state === "ok")?.id ?? null,
      backends,
    };
  });
