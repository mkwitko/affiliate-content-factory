/** Server-owned model policy. Worker labels and local manifests are observations, never authority. */
export type ModelCapability =
  | "scene_director"
  | "visual_qa"
  | "image_generation"
  | "image_editing"
  | "video_generation"
  | "upscale"
  | "segmentation"
  | "tts"
  | "asr";
export type ModelLicensePolicy = "commercial_allowed" | "research_only" | "unknown" | "blocked";
export type ModelProfile = Readonly<{
  id: string;
  capability: ModelCapability;
  provider: string;
  runtime: string;
  expectedModel: string;
  license: string;
  licensePolicy: ModelLicensePolicy;
  enabled: boolean;
  /** Owner-promoted for unattended affiliate copy; independent of scene direction. */
  copywriting?: boolean;
  experimental: boolean;
  quantization?: string;
  hardwareClass?: string;
}>;

const local = (
  id: string,
  capability: ModelCapability,
  expectedModel: string,
  license: string,
  options: Readonly<{
    enabled?: boolean;
    copywriting?: boolean;
    runtime?: string;
    quantization?: string;
    hardwareClass?: string;
    licensePolicy?: ModelLicensePolicy;
  }> = {},
): ModelProfile => ({
  id,
  capability,
  provider: "local",
  runtime: options.runtime ?? "llama.cpp",
  expectedModel,
  license,
  licensePolicy: options.licensePolicy ?? "commercial_allowed",
  enabled: options.enabled ?? false,
  experimental: !(options.enabled ?? false),
  ...(options.copywriting ? { copywriting: true } : {}),
  ...(options.quantization ? { quantization: options.quantization } : {}),
  ...(options.hardwareClass ? { hardwareClass: options.hardwareClass } : {}),
});

/**
 * A model hosted by a cloud provider (spec 2026-10-14): commercial use approved by the owner on
 * 2026-10-14 after reading the provider terms (Vercel AI Gateway on the Pro plan assigns outputs to
 * the customer; BFL claims no rights in FLUX outputs on Workers AI). Routing still waits for
 * qualification: a profile only makes the model admissible, never chosen.
 */
const hosted = (
  id: string,
  capability: ModelCapability,
  provider: "cloudflare" | "vercel_ai_gateway",
  expectedModel: string,
  license: string,
  options: Readonly<{ enabled?: boolean; copywriting?: boolean }> = {},
): ModelProfile => ({
  id,
  capability,
  provider,
  runtime: provider === "cloudflare" ? "workers-ai" : "ai-gateway",
  expectedModel,
  license,
  licensePolicy: "commercial_allowed",
  enabled: options.enabled ?? false,
  experimental: !(options.enabled ?? false),
  ...(options.copywriting ? { copywriting: true } : {}),
});

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = Object.freeze(
  Object.fromEntries(
    [
      local("local:qwen3.5-4b", "scene_director", "Qwen/Qwen3.5-4B", "Apache-2.0", {
        enabled: true,
      }),
      // Copy champion: promoted by the owner on 2026-10-08 after the arena qualification on 18
      // real products x 2 runs (docs/content-generation/results/2026-10-08-copy-qualification.md).
      local("local:qwen3.5-9b", "scene_director", "Qwen/Qwen3.5-9B", "Apache-2.0", {
        enabled: true,
        copywriting: true,
      }),
      local("local:gemma-4-e4b", "scene_director", "google/gemma-4-e4b", "Apache-2.0", {
        enabled: true,
      }),
      local("local:ministral-3-3b", "scene_director", "mistralai/Ministral-3-3B", "Apache-2.0", {
        enabled: true,
      }),
      local("local:ministral-3-8b", "scene_director", "mistralai/Ministral-3-8B", "Apache-2.0", {
        enabled: true,
      }),
      local("local:bonsai-8b", "scene_director", "prism-ml/Ternary-Bonsai-8B", "Apache-2.0", {
        enabled: true,
      }),
      local(
        "local:ternary-bonsai-2-27b",
        "scene_director",
        "prism-ml/Ternary-Bonsai-2-27B-gguf",
        "Apache-2.0",
        { runtime: "prism-llama.cpp", quantization: "PTQ1_0", hardwareClass: "desktop_amd" },
      ),
      local(
        "local:qwen3.8-4b-distill",
        "scene_director",
        "empero-ai/Qwen3.8-4B-Distill-GGUF",
        "Apache-2.0",
        { quantization: "Q6_K", hardwareClass: "desktop_amd" },
      ),
      local(
        "local:qwen3.8-9b-distill",
        "scene_director",
        "empero-ai/Qwen3.8-9B-Distill-GGUF",
        "Apache-2.0",
        { quantization: "Q4_K_M", hardwareClass: "desktop_amd" },
      ),
      local("local:qwen3-vl-2b", "visual_qa", "Qwen/Qwen3-VL-2B-Instruct-GGUF", "Apache-2.0", {
        enabled: true,
      }),
      hosted(
        "workers-ai:flux-2-klein-4b",
        "image_editing",
        "cloudflare",
        "@cf/black-forest-labs/flux-2-klein-4b",
        "BFL Terms of Service via Cloudflare Workers AI (no rights claimed in outputs)",
        { enabled: true },
      ),
      hosted(
        "vercel:alibaba/qwen3-vl-instruct",
        "visual_qa",
        "vercel_ai_gateway",
        "alibaba/qwen3-vl-instruct",
        "Qwen3-VL (Apache-2.0 weights) via Vercel AI Gateway, Pro plan (outputs assigned to the customer)",
        { enabled: true },
      ),
      // Cloud copy while the desktop is off: promoted for the production trial by the owner on
      // 2026-10-14 (option A); copy still passes validateOfferCopyDraft and the package review.
      hosted(
        "vercel:alibaba/qwen3.8-flash",
        "scene_director",
        "vercel_ai_gateway",
        "alibaba/qwen3.8-flash",
        "Qwen via Vercel AI Gateway, Pro plan (outputs assigned to the customer)",
        { enabled: true, copywriting: true },
      ),
      local("local:qwen3-vl-4b", "visual_qa", "Qwen/Qwen3-VL-4B-Instruct-GGUF", "Apache-2.0", {
        enabled: true,
        quantization: "Q4_K_M",
      }),
      local("local:qwen3-vl-8b", "visual_qa", "Qwen/Qwen3-VL-8B-Instruct-GGUF", "Apache-2.0", {
        enabled: true,
      }),
      local("local:minicpm-v-4.6", "visual_qa", "openbmb/MiniCPM-V-4.6-gguf", "Apache-2.0"),
      local("local:realesrgan-ncnn-vulkan", "upscale", "Real-ESRGAN ncnn Vulkan", "MIT", {
        enabled: true,
        runtime: "ncnn-vulkan",
      }),
      local("local:rife-ncnn-vulkan", "upscale", "RIFE ncnn Vulkan", "MIT", {
        enabled: true,
        runtime: "ncnn-vulkan",
      }),
      local("local:birefnet", "segmentation", "BiRefNet", "MIT", {
        enabled: true,
        runtime: "onnx",
      }),
      // Arena challengers (docs/content-generation/model-landscape-*.md). Disabled until promoted;
      // "unknown" licences cannot run in a commercial path until the weights licence is read.
      local("local:ben2-base", "segmentation", "PramaLLC/BEN2", "MIT", { runtime: "onnx" }),
      local("local:realcugan-ncnn-vulkan", "upscale", "Real-CUGAN ncnn Vulkan", "MIT (code)", {
        runtime: "ncnn-vulkan",
        licensePolicy: "unknown",
      }),
      local("local:kokoro", "tts", "hexgrad/Kokoro-82M", "Apache-2.0", {
        enabled: true,
        runtime: "kokoro-fastapi",
      }),
      // Served by VoiceStudio (AGPL-3.0, external HTTP service only). Bench only.
      local("local:moss-tts-nano", "tts", "OpenMOSS/MOSS-TTS-Nano", "Apache-2.0", {
        runtime: "voicestudio",
      }),
      local("local:qwen3-tts", "tts", "Qwen/Qwen3-TTS-1.7B", "Apache-2.0"),
      local("local:chatterbox-multilingual", "tts", "ResembleAI/chatterbox", "MIT"),
      // TTS/ASR arena challengers served by audio.cpp (licences per its model_licenses.md,
      // checked 2026-09-21..10-04). Disabled until promoted.
      local("local:qwen3-tts-0.6b", "tts", "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "Apache-2.0", {
        runtime: "audio.cpp",
      }),
      local("local:voxcpm2", "tts", "openbmb/VoxCPM2", "Apache-2.0", { runtime: "audio.cpp" }),
      local("local:pocket-tts", "tts", "kyutai/pocket-tts", "CC-BY-4.0 (attribution)", {
        runtime: "audio.cpp",
      }),
      local(
        "local:magpie-tts",
        "tts",
        "nvidia/magpie_tts_multilingual_357m",
        "NVIDIA Open Model License",
        {
          runtime: "audio.cpp",
        },
      ),
      local(
        "local:supertonic-3",
        "tts",
        "Supertone/supertonic-3",
        "OpenRAIL-M (use restrictions)",
        {
          runtime: "audio.cpp",
        },
      ),
      local("local:qwen3-asr-1.7b", "asr", "Qwen/Qwen3-ASR-1.7B", "Apache-2.0", {
        runtime: "audio.cpp",
      }),
      local("local:qwen3-asr-0.6b", "asr", "Qwen/Qwen3-ASR-0.6B", "Apache-2.0", {
        runtime: "audio.cpp",
      }),
      local(
        "local:parakeet-tdt-0.6b-v3",
        "asr",
        "nvidia/parakeet-tdt-0.6b-v3",
        "CC-BY-4.0 (attribution)",
        // ASR champion since 2026-10-08 (WER 1.1 % vs 1.9 %, 8x faster than Qwen3-ASR 1.7B).
        { runtime: "audio.cpp", enabled: true },
      ),
      local(
        "local:cohere-transcribe",
        "asr",
        "CohereLabs/cohere-transcribe-03-2026",
        "Apache-2.0",
        {
          runtime: "audio.cpp",
        },
      ),
      local(
        "local:flux-1-schnell",
        "image_generation",
        "black-forest-labs/FLUX.1-schnell",
        "Apache-2.0",
        { enabled: true, runtime: "stable-diffusion.cpp" },
      ),
      local("local:z-image-turbo", "image_generation", "unsloth/Z-Image-Turbo-GGUF", "Apache-2.0", {
        enabled: true,
        runtime: "stable-diffusion.cpp",
        quantization: "Q4_K_M",
      }),
      local("local:bonsai-image-4b", "image_generation", "prism-ml/Bonsai-Image-4B", "Apache-2.0", {
        enabled: true,
        runtime: "prism-llama.cpp",
      }),
      local(
        "local:flux-2-klein-4b",
        "image_editing",
        "black-forest-labs/FLUX.2-klein-4B",
        "Apache-2.0",
        { enabled: true, runtime: "stable-diffusion.cpp" },
      ),
      local(
        "local:mage-flow-edit-4b-turbo",
        "image_editing",
        "microsoft/Mage-Flow-Edit-4B-Turbo",
        "MIT (repack card; official card unread)",
        { runtime: "stable-diffusion.cpp", hardwareClass: "desktop_amd", licensePolicy: "unknown" },
      ),
      local(
        "local:longcat-image-edit-turbo",
        "image_editing",
        "meituan-longcat/LongCat-Image-Edit-Turbo",
        "Apache-2.0",
        { runtime: "stable-diffusion.cpp", hardwareClass: "desktop_amd" },
      ),
      local(
        "local:qwen-image-edit-2511",
        "image_editing",
        "unsloth/Qwen-Image-Edit-2511-GGUF",
        "Apache-2.0",
        { runtime: "stable-diffusion.cpp", quantization: "Q2_K", hardwareClass: "quality_ceiling" },
      ),
      local(
        "local:wan2.2-ti2v-5b",
        "video_generation",
        "QuantStack/Wan2.2-TI2V-5B-GGUF",
        "Apache-2.0",
        { runtime: "stable-diffusion.cpp", quantization: "Q4_K_M", hardwareClass: "desktop_amd" },
      ),
      local(
        "local:fastwan2.2-ti2v-5b",
        "video_generation",
        "Green-Sky/FastWan2.2-TI2V-5B-FullAttn-GGUF",
        "Apache-2.0",
        { runtime: "stable-diffusion.cpp", quantization: "Q6_K", hardwareClass: "desktop_amd" },
      ),
      local(
        "Qwen/Qwen-Image-2.1",
        "image_generation",
        "Qwen/Qwen-Image-2.1",
        "Qwen Research License",
        { licensePolicy: "research_only" },
      ),
    ].map((profile) => [profile.id, profile]),
  ),
);

export const modelPolicyFor = (id: string): ModelProfile | undefined => MODEL_PROFILES[id];
export const mayUseModelCommercially = (id: string): boolean =>
  modelPolicyFor(id)?.licensePolicy === "commercial_allowed";

/** Existing public allowlists are derived from this registry for compatibility. */
export const LOCAL_GENERATOR_LICENSES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(MODEL_PROFILES)
      .filter((profile) =>
        ["image_generation", "image_editing", "video_generation"].includes(profile.capability),
      )
      .filter((profile) => profile.licensePolicy === "commercial_allowed")
      .map((profile) => [profile.id, profile.license]),
  ),
);
export const LOCAL_MODEL_LICENSES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.values(MODEL_PROFILES)
      .filter((profile) =>
        ["scene_director", "visual_qa", "upscale", "segmentation", "tts", "asr"].includes(
          profile.capability,
        ),
      )
      .filter((profile) => profile.licensePolicy === "commercial_allowed")
      .map((profile) => [profile.id, profile.license]),
  ),
);
