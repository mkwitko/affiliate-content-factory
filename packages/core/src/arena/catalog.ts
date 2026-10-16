/**
 * Model arena catalog: every candidate the arena can download, start and test, per task.
 * Sources checked on Hugging Face 2026-10-06 (repo, file, size, weights licence); the licence
 * gate itself is `MODEL_PROFILES` (a catalog entry without a profile never runs). Sizes are for
 * disk planning; the downloader trusts the server's length, not this table.
 */
export const ARENA_TASKS = [
  "llm.offer_copy",
  "vision.product_verification",
  "image.character_product",
  "image.scene_plate",
  "tts.ptbr",
  "asr.ptbr",
  "upscale.illustration",
  "video.i2v",
] as const;
export type ArenaTask = (typeof ARENA_TASKS)[number];

/** Where a runtime can run: the dev box CPU, or the RX 6650 XT desktop (Vulkan). */
export type ArenaTarget = "cpu" | "desktop_amd";

export type ArenaFile = Readonly<{ url: string; file: string; bytes: number }>;

export type ArenaLaunch =
  | Readonly<{
      runtime: "llama-server";
      model: string;
      mmproj?: string;
      contextSize: number;
    }>
  | Readonly<{
      runtime: "sd-server";
      diffusionModel: string;
      vae?: string;
      llm?: string;
      llmVision?: string;
      t5xxl?: string;
      /** Extra sd-server flags, e.g. "--params-backend", "te=cpu,vae=cpu". */
      args: readonly string[];
      steps: number;
    }>
  | Readonly<{
      runtime: "audiocpp-server";
      family: string;
      task: "tts" | "asr";
      file: string;
      /** Request options sent with every call (voice, language, speed...). */
      request: Readonly<Record<string, string | number>>;
      /** Server model options (audio.cpp `load_options`). */
      load?: Readonly<Record<string, string>>;
      /** Needs a reference voice: the arena synthesizes one with the TTS champion. */
      voiceReference?: boolean;
      /** audio.cpp server task when it is not the plain task (Chatterbox only clones: "clon"). */
      serverTask?: "clon";
    }>
  | Readonly<{ runtime: "realesrgan-ncnn"; modelName: string; scale: 2 | 4 }>
  | Readonly<{ runtime: "realcugan-ncnn"; noise: -1 | 0 | 3; scale: 2 }>;

export type ArenaCandidate = Readonly<{
  /** Key in MODEL_PROFILES (licence gate) plus a variant suffix after "#" when needed. */
  id: string;
  task: ArenaTask;
  targets: readonly ArenaTarget[];
  files: readonly ArenaFile[];
  launch: ArenaLaunch;
  champion?: true;
  /** Skipped unless named with --only (very slow or a quality ceiling). */
  optional?: true;
  notes?: string;
}>;

const HF = "https://huggingface.co";
const hf = (repo: string, path: string, gb: number): ArenaFile => ({
  url: `${HF}/${repo}/resolve/main/${path}`,
  file: path.split("/").at(-1) as string,
  bytes: Math.round(gb * 1e9),
});
const AUDIOCPP = "audio-cpp/audio.cpp-gguf";

/** The profile id behind a catalog id ("local:kokoro#pf_dora" -> "local:kokoro"). */
export const profileIdOf = (candidateId: string): string => candidateId.split("#")[0] as string;

const llm = (
  id: string,
  repo: string,
  file: string,
  gb: number,
  extra: Partial<ArenaCandidate> = {},
): ArenaCandidate => ({
  id,
  task: "llm.offer_copy",
  targets: ["cpu", "desktop_amd"],
  files: [hf(repo, file, gb)],
  launch: { runtime: "llama-server", model: file, contextSize: 8192 },
  ...extra,
});

const vlm = (
  id: string,
  repo: string,
  file: string,
  gb: number,
  mmproj: string,
  mmprojGb: number,
  extra: Partial<ArenaCandidate> = {},
): ArenaCandidate => ({
  id,
  task: "vision.product_verification",
  targets: ["cpu", "desktop_amd"],
  files: [hf(repo, file, gb), hf(repo, mmproj, mmprojGb)],
  launch: { runtime: "llama-server", model: file, mmproj, contextSize: 8192 },
  ...extra,
});

const tts = (
  id: string,
  dir: string,
  file: string,
  gb: number,
  family: string,
  request: Readonly<Record<string, string | number>>,
  extra: Partial<ArenaCandidate> & {
    load?: Readonly<Record<string, string>>;
    voiceReference?: boolean;
    serverTask?: "clon";
  } = {},
): ArenaCandidate => {
  const { load, voiceReference, serverTask, ...rest } = extra;
  return {
    id,
    task: "tts.ptbr",
    targets: ["cpu"],
    files: [hf(AUDIOCPP, `${dir}/${file}`, gb)],
    launch: {
      runtime: "audiocpp-server",
      family,
      task: "tts",
      file,
      request,
      ...(load ? { load } : {}),
      ...(voiceReference ? { voiceReference } : {}),
      ...(serverTask ? { serverTask } : {}),
    },
    ...rest,
  };
};

const asr = (
  id: string,
  dir: string,
  file: string,
  gb: number,
  family: string,
  extra: Partial<ArenaCandidate> = {},
): ArenaCandidate => ({
  id,
  task: "asr.ptbr",
  targets: ["cpu"],
  files: [hf(AUDIOCPP, `${dir}/${file}`, gb)],
  launch: { runtime: "audiocpp-server", family, task: "asr", file, request: { language: "pt" } },
  ...extra,
});

const SD_CPU_TEXT = ["--params-backend", "te=cpu,vae=cpu", "--diffusion-fa", "--vae-tiling"];

/**
 * The same sd.cpp model with the diffusion run on the CPU. 2026-10-08: Mage-Flow gave flat grey
 * images on the RX 6650 XT (Vulkan, no bf16) but a correct image with the same weights and
 * arguments on the dev box CPU, so the Vulkan path is at fault. Slow, so it runs
 * only when named with --only.
 */
const onCpu = (candidate: ArenaCandidate): ArenaCandidate =>
  candidate.launch.runtime === "sd-server"
    ? {
        ...candidate,
        id: `${candidate.id}#cpu`,
        optional: true,
        launch: {
          ...candidate.launch,
          args: [...(candidate.launch.args ?? []), "--backend", "diffusion=cpu"],
        },
      }
    : candidate;

const MAGE_FLOW: ArenaCandidate = {
  id: "local:mage-flow-edit-4b-turbo",
  task: "image.character_product",
  targets: ["desktop_amd"],
  files: [
    hf("johnsor/Mage-Flow-Edit-Turbo-GGUF", "mage-flow-edit-turbo-Q5_K.gguf", 2.84),
    hf("Comfy-Org/Mage-Flow", "vae/mage_flow_vae_bf16.safetensors", 0.35),
    hf("Qwen/Qwen3-VL-4B-Instruct-GGUF", "Qwen3VL-4B-Instruct-Q4_K_M.gguf", 2.5),
    hf("Qwen/Qwen3-VL-4B-Instruct-GGUF", "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf", 0.45),
  ],
  launch: {
    runtime: "sd-server",
    diffusionModel: "mage-flow-edit-turbo-Q5_K.gguf",
    vae: "mage_flow_vae_bf16.safetensors",
    llm: "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
    llmVision: "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
    args: [...SD_CPU_TEXT, "--cfg-scale", "1.0", "--sampling-method", "euler"],
    steps: 4,
  },
  notes: "weights licence unread on the gated microsoft card: arena only",
};

const LONGCAT: ArenaCandidate = {
  id: "local:longcat-image-edit-turbo",
  task: "image.character_product",
  targets: ["desktop_amd"],
  files: [
    hf("vantagewithai/LongCat-Image-Edit-Turbo-GGUF", "LongCat-Image-Edit-Turbo-Q4_K_M.gguf", 3.87),
    hf("unsloth/Qwen2.5-VL-7B-Instruct-GGUF", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", 4.68),
    hf("unsloth/Qwen2.5-VL-7B-Instruct-GGUF", "mmproj-F16.gguf", 1.35),
    hf("Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 0.34),
  ],
  launch: {
    runtime: "sd-server",
    diffusionModel: "LongCat-Image-Edit-Turbo-Q4_K_M.gguf",
    vae: "ae.safetensors",
    llm: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
    llmVision: "mmproj-F16.gguf",
    // sd.cpp docs/longcat_image.md: euler with flow shift 3.
    args: [
      ...SD_CPU_TEXT,
      "--cfg-scale",
      "1.0",
      "--sampling-method",
      "euler",
      "--flow-shift",
      "3",
      "--offload-to-cpu",
    ],
    steps: 8,
  },
};

export const ARENA_CATALOG: readonly ArenaCandidate[] = Object.freeze([
  // Copy and structured planning (llama.cpp). Champion since 2026-10-08: Qwen3.5-9B.
  llm(
    "local:qwen3.8-9b-distill",
    "empero-ai/Qwen3.8-9B-Distill-GGUF",
    "Qwen3.8-9B-Q4_K_M.gguf",
    5.78,
    { notes: "community distill of Qwen3.5-9B; the director baseline; provenance unknown" },
  ),
  llm("local:qwen3.5-9b", "unsloth/Qwen3.5-9B-GGUF", "Qwen3.5-9B-Q4_K_M.gguf", 5.68, {
    champion: true,
    notes: "official Qwen weights",
  }),
  llm("local:qwen3.5-4b", "unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf", 2.74),
  llm(
    "local:qwen3.8-4b-distill",
    "empero-ai/Qwen3.8-4B-Distill-GGUF",
    "Qwen3.8-4B-Q4_K_M.gguf",
    2.78,
  ),
  llm("local:gemma-4-e4b", "ggml-org/gemma-4-E4B-it-GGUF", "gemma-4-E4B-it-Q4_0.gguf", 4.59),
  llm(
    "local:ministral-3-8b",
    "mistralai/Ministral-3-8B-Instruct-2512-GGUF",
    "Ministral-3-8B-Instruct-2512-Q4_K_M.gguf",
    5.2,
  ),

  // Product verification against the listing photo (llama.cpp + mmproj).
  vlm(
    "local:qwen3-vl-4b",
    "Qwen/Qwen3-VL-4B-Instruct-GGUF",
    "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
    2.5,
    "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
    0.45,
    { champion: true },
  ),
  vlm(
    "local:qwen3-vl-2b",
    "Qwen/Qwen3-VL-2B-Instruct-GGUF",
    "Qwen3VL-2B-Instruct-Q4_K_M.gguf",
    1.11,
    "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
    0.45,
  ),
  vlm(
    "local:qwen3-vl-8b",
    "Qwen/Qwen3-VL-8B-Instruct-GGUF",
    "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    5.03,
    "mmproj-Qwen3VL-8B-Instruct-Q8_0.gguf",
    0.75,
  ),
  vlm(
    "local:minicpm-v-4.6",
    "openbmb/MiniCPM-V-4.6-gguf",
    "MiniCPM-V-4_6-Q4_K_M.gguf",
    0.53,
    "mmproj-model-f16.gguf",
    1.11,
  ),

  // Character + real product scenes (sd.cpp reference edit), desktop GPU only.
  {
    id: "local:flux-2-klein-4b",
    task: "image.character_product",
    targets: ["desktop_amd"],
    champion: true,
    files: [
      hf("leejet/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q4_0.gguf", 2.46),
      hf("unsloth/Qwen3-4B-GGUF", "Qwen3-4B-Q4_K_M.gguf", 2.5),
      hf("black-forest-labs/FLUX.2-small-decoder", "full_encoder_small_decoder.safetensors", 0.25),
    ],
    launch: {
      runtime: "sd-server",
      diffusionModel: "flux-2-klein-4b-Q4_0.gguf",
      vae: "full_encoder_small_decoder.safetensors",
      llm: "Qwen3-4B-Q4_K_M.gguf",
      args: [...SD_CPU_TEXT, "--cfg-scale", "1.0"],
      steps: 4,
    },
  },
  MAGE_FLOW,
  onCpu(MAGE_FLOW),
  LONGCAT,
  onCpu(LONGCAT),
  {
    id: "local:qwen-image-edit-2511",
    task: "image.character_product",
    targets: ["desktop_amd"],
    optional: true,
    files: [
      hf("unsloth/Qwen-Image-Edit-2511-GGUF", "qwen-image-edit-2511-Q2_K.gguf", 7.47),
      hf("unsloth/Qwen2.5-VL-7B-Instruct-GGUF", "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf", 4.68),
      hf("unsloth/Qwen2.5-VL-7B-Instruct-GGUF", "mmproj-F16.gguf", 1.35),
      hf("Comfy-Org/Qwen-Image_ComfyUI", "split_files/vae/qwen_image_vae.safetensors", 0.25),
    ],
    launch: {
      runtime: "sd-server",
      diffusionModel: "qwen-image-edit-2511-Q2_K.gguf",
      vae: "qwen_image_vae.safetensors",
      llm: "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
      llmVision: "mmproj-F16.gguf",
      args: [...SD_CPU_TEXT, "--cfg-scale", "2.5", "--offload-to-cpu"],
      steps: 8,
    },
    notes: "20B quality ceiling at Q2_K; expect tens of minutes per image",
  },

  // Empty background plates (sd.cpp text-to-image).
  {
    id: "local:z-image-turbo",
    task: "image.scene_plate",
    targets: ["desktop_amd"],
    champion: true,
    files: [
      hf("leejet/Z-Image-Turbo-GGUF", "z_image_turbo-Q4_K.gguf", 3.9),
      hf("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", 2.5),
      hf("Comfy-Org/z_image_turbo", "split_files/vae/ae.safetensors", 0.34),
    ],
    launch: {
      runtime: "sd-server",
      diffusionModel: "z_image_turbo-Q4_K.gguf",
      vae: "ae.safetensors",
      llm: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
      args: ["--diffusion-fa", "--vae-tiling", "--cfg-scale", "1.0"],
      steps: 4,
    },
  },

  // pt-BR narration (audio.cpp server, CPU). Kokoro is the production voice.
  tts(
    "local:kokoro#pf_dora",
    "Kokoro-82M-GGUF",
    "kokoro-82m-q8_0.gguf",
    0.19,
    "kokoro_tts",
    {
      voice: "pf_dora",
      language: "pt-br",
    },
    { champion: true },
  ),
  tts("local:kokoro#pm_alex", "Kokoro-82M-GGUF", "kokoro-82m-q8_0.gguf", 0.19, "kokoro_tts", {
    voice: "pm_alex",
    language: "pt-br",
  }),
  tts(
    "local:chatterbox-multilingual",
    "Chatterbox-GGUF",
    "chatterbox-q8_0.gguf",
    2.09,
    "chatterbox",
    { language: "pt" },
    {
      voiceReference: true,
      serverTask: "clon",
      notes: "voice cloning from a Kokoro pf_dora reference",
    },
  ),
  tts(
    "local:qwen3-tts",
    "Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF",
    "qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf",
    2.82,
    "qwen3_tts",
    { language: "portuguese", voice: "Vivian" },
  ),
  tts(
    "local:qwen3-tts-0.6b",
    "Qwen3-TTS-12Hz-0.6B-Base-GGUF",
    "qwen3-tts-12hz-0.6b-base-q8_0.gguf",
    1.99,
    "qwen3_tts",
    { language: "portuguese" },
    { voiceReference: true },
  ),
  tts("local:voxcpm2", "VoxCPM2-GGUF", "voxcpm2-q8_0.gguf", 2.96, "voxcpm2", { language: "pt" }),
  tts(
    "local:pocket-tts",
    "PocketTTS-GGUF",
    "portuguese/pocket-tts-portuguese-q8_0.gguf",
    0.13,
    "pocket_tts",
    {},
    { load: { language: "portuguese" }, voiceReference: true },
  ),
  tts(
    "local:magpie-tts",
    "MagpieTTS-Multilingual-357M-GGUF",
    "magpie-tts-multilingual-357m-q8_0.gguf",
    1.56,
    "magpie_tts",
    { language: "pt-BR" },
  ),
  tts("local:supertonic-3", "Supertonic-3-GGUF", "supertonic-3-q8_0.gguf", 0.45, "supertonic", {
    language: "pt",
  }),

  // pt-BR transcription (caption timing and the TTS round-trip judge).
  asr("local:qwen3-asr-1.7b", "Qwen3-ASR-1.7B-GGUF", "qwen3-asr-1.7b-q8_0.gguf", 2.47, "qwen3_asr"),
  asr("local:qwen3-asr-0.6b", "Qwen3-ASR-0.6B-GGUF", "qwen3-asr-0.6b-q8_0.gguf", 1.15, "qwen3_asr"),
  asr(
    "local:parakeet-tdt-0.6b-v3",
    "Parakeet-TDT-0.6B-v3-GGUF",
    "parakeet-tdt-0.6b-v3-q8_0.gguf",
    0.92,
    "parakeet_tdt",
    { champion: true },
  ),
  asr(
    "local:cohere-transcribe",
    "Cohere-Transcribe-GGUF",
    "cohere-transcribe-03-2026-q4_0.gguf",
    1.53,
    "cohere_asr",
  ),

  // 2x upscale of 512 px art (ncnn Vulkan; models ship inside the release zip).
  {
    id: "local:realesrgan-ncnn-vulkan#animevideov3",
    task: "upscale.illustration",
    targets: ["desktop_amd"],
    champion: true,
    files: [],
    launch: { runtime: "realesrgan-ncnn", modelName: "realesr-animevideov3", scale: 2 },
  },
  {
    id: "local:realesrgan-ncnn-vulkan#x4plus-anime",
    task: "upscale.illustration",
    targets: ["desktop_amd"],
    files: [],
    launch: { runtime: "realesrgan-ncnn", modelName: "realesrgan-x4plus-anime", scale: 4 },
  },
  {
    id: "local:realesrgan-ncnn-vulkan#x4plus",
    task: "upscale.illustration",
    targets: ["desktop_amd"],
    files: [],
    launch: { runtime: "realesrgan-ncnn", modelName: "realesrgan-x4plus", scale: 4 },
  },
  {
    id: "local:realcugan-ncnn-vulkan",
    task: "upscale.illustration",
    targets: ["desktop_amd"],
    files: [],
    launch: { runtime: "realcugan-ncnn", noise: 0, scale: 2 },
  },

  // 1-2 s image-to-video (sd.cpp Wan2.2 TI2V 5B with the tiny decoder).
  {
    id: "local:wan2.2-ti2v-5b",
    task: "video.i2v",
    targets: ["desktop_amd"],
    champion: true,
    files: [
      hf("QuantStack/Wan2.2-TI2V-5B-GGUF", "Wan2.2-TI2V-5B-Q4_K_M.gguf", 3.43),
      hf("city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q4_K_M.gguf", 3.66),
      {
        url: "https://github.com/madebyollin/taehv/raw/refs/heads/main/safetensors/taew2_2.safetensors",
        file: "taew2_2.safetensors",
        bytes: 25_000_000,
      },
    ],
    launch: {
      runtime: "sd-server",
      diffusionModel: "Wan2.2-TI2V-5B-Q4_K_M.gguf",
      t5xxl: "umt5-xxl-encoder-Q4_K_M.gguf",
      // 2026-10-07: sampling worked (~9 min a clip) but the TAE decode ran out of VRAM on the
      // RX 6650 XT; decode tiled and on the CPU.
      args: [
        "--tae",
        "taew2_2.safetensors",
        "--diffusion-fa",
        "--offload-to-cpu",
        "--flow-shift",
        "3.0",
        "--vae-tiling",
        "--params-backend",
        "vae=cpu",
      ],
      steps: 8,
    },
  },
  // FastVideo's 3-step DMD distill of the same 5B model (Apache-2.0, GGUF by an sd.cpp
  // contributor). Few steps need cfg 1 and flow shift 5 (its scheduler config); 4 euler steps
  // stand in for the DMD timesteps 1000/757/522. Distilled on text-to-video: the bench decides
  // whether image-to-video holds. The text encoder stays on the CPU instead of --offload-to-cpu.
  {
    id: "local:fastwan2.2-ti2v-5b",
    task: "video.i2v",
    targets: ["desktop_amd"],
    files: [
      hf("Green-Sky/FastWan2.2-TI2V-5B-FullAttn-GGUF", "FastWan2.2-TI2V-5B-q6_k.gguf", 4.21),
      hf("city96/umt5-xxl-encoder-gguf", "umt5-xxl-encoder-Q4_K_M.gguf", 3.66),
      {
        url: "https://github.com/madebyollin/taehv/raw/refs/heads/main/safetensors/taew2_2.safetensors",
        file: "taew2_2.safetensors",
        bytes: 25_000_000,
      },
    ],
    launch: {
      runtime: "sd-server",
      diffusionModel: "FastWan2.2-TI2V-5B-q6_k.gguf",
      t5xxl: "umt5-xxl-encoder-Q4_K_M.gguf",
      args: [
        "--tae",
        "taew2_2.safetensors",
        ...SD_CPU_TEXT,
        "--flow-shift",
        "5.0",
        "--cfg-scale",
        "1.0",
        "--sampling-method",
        "euler",
      ],
      steps: 4,
    },
  },
]);

export const candidatesFor = (task: ArenaTask): readonly ArenaCandidate[] =>
  ARENA_CATALOG.filter((candidate) => candidate.task === task);

export const championFor = (task: ArenaTask): ArenaCandidate | undefined =>
  candidatesFor(task).find((candidate) => candidate.champion);
