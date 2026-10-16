import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isLocalClipProfile,
  type LocalClipProfile,
  localClipProfile,
} from "@money-maker/core/assets/local-clip-profile";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import type { ClipProbe } from "@money-maker/core/home-worker/tasks";
import { meanFrameDiff, probeVideo } from "@money-maker/providers/media/clip-video";
import {
  createSdCppVideoGenerator,
  type VideoGenerator,
} from "@money-maker/providers/media/sdcpp-video-generator";

/**
 * F2: local image-to-video benchmark against stable-diffusion.cpp servers. Evidence for the
 * owner's decision to promote a model in model policy; nothing is promoted or stored here (no
 * video is written, only metric rows). Memory, drift and quality columns are filled by hand.
 */
export type VideoCandidate = Readonly<{
  baseUrl: string;
  model: string;
  quantization: string | null;
  steps: number;
}>;

/** Fixed keyframe filenames (`--keyframes <dir>`) and the motion prompt used with each. */
export const KEYFRAMES = [
  {
    id: "cost-curious",
    file: "cost-curious.png",
    prompt: "gentle camera push-in on the scene, soft natural light, calm everyday motion",
  },
  {
    id: "affiliate-world",
    file: "affiliate-world.png",
    prompt: "slow parallax across the shop scene, people moving naturally in the background",
  },
  {
    id: "character-motion",
    file: "character-motion.png",
    prompt: "the character turns and gestures while speaking, natural body motion",
  },
  {
    id: "camera-motion",
    file: "camera-motion.png",
    prompt: "slow pan across the environment, parallax depth, steady camera",
  },
  {
    id: "diagram",
    file: "diagram.png",
    prompt: "the diagram elements animate in one by one, subtle highlight pulses",
  },
] as const;
const NEGATIVE = "logos, readable text, watermarks, deformed hands, flicker";
const FRAME_COUNTS = [17, 25, 33] as const;

export type VideoBenchRow = Readonly<{
  model: string;
  quantization: string | null;
  keyframe: string;
  resolution: string | null;
  frames: number | null;
  fps: number | null;
  steps: number | null;
  /** Whether model policy has promoted the model (the bench may still run a disabled one). */
  policyEnabled: boolean | null;
  wallMs: number | null;
  outputBytes: number | null;
  decodeValid: boolean;
  frameCount: number | null;
  /** ffprobe decode error lines: a count of reported problems, not of provably bad frames. */
  corruptFrames: number | null;
  /** Heuristic flicker proxy (mean luma change between frames), not a quality score. */
  meanFrameDiff: number | null;
  peakVramMb: null;
  peakRamMb: null;
  subjectDrift: null;
  characterDrift: null;
  styleDrift: null;
  motionQuality: null;
  vlmFindings: null;
  humanScore: null;
  error: string | null;
}>;

export const readVideoBenchCandidates = (
  env: Readonly<Record<string, string | undefined>>,
): readonly VideoCandidate[] => {
  let value: unknown;
  try {
    value = JSON.parse(env.VIDEO_BENCH_CANDIDATES ?? "");
  } catch {
    throw new Error("video_bench_candidates_invalid");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new Error("video_bench_candidates_invalid");
  return value.map((item: unknown) => {
    const c = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (
      typeof c.baseUrl !== "string" ||
      typeof c.model !== "string" ||
      (c.quantization != null && typeof c.quantization !== "string") ||
      !Number.isInteger(c.steps) ||
      (c.steps as number) < 1 ||
      (c.steps as number) > 20
    )
      throw new Error("video_bench_candidates_invalid");
    return {
      baseUrl: c.baseUrl,
      model: c.model,
      quantization: (c.quantization as string | null | undefined) ?? null,
      steps: c.steps as number,
    };
  });
};

/** Only models model policy lists as video generators; a disabled one is allowed here only. */
export const videoCandidateRefusal = (model: string): string | null => {
  const policy = modelPolicyFor(model);
  if (!policy) return "model_not_allowed";
  if (policy.capability !== "video_generation") return "model_not_video_generation";
  if (policy.licensePolicy !== "commercial_allowed") return "model_license_not_commercial";
  return null;
};

const row = (
  candidate: VideoCandidate,
  keyframe: string,
  over: { -readonly [K in keyof VideoBenchRow]?: VideoBenchRow[K] },
): VideoBenchRow => ({
  model: candidate.model,
  quantization: candidate.quantization,
  keyframe,
  resolution: null,
  frames: null,
  fps: null,
  steps: candidate.steps,
  policyEnabled: modelPolicyFor(candidate.model)?.enabled ?? null,
  wallMs: null,
  outputBytes: null,
  decodeValid: false,
  frameCount: null,
  corruptFrames: null,
  meanFrameDiff: null,
  peakVramMb: null,
  peakRamMb: null,
  subjectDrift: null,
  characterDrift: null,
  styleDrift: null,
  motionQuality: null,
  vlmFindings: null,
  humanScore: null,
  error: null,
  ...over,
});

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
    ? error.message
    : "generation_failed";

export type VideoBenchOptions = Readonly<{
  canvas: "landscape" | "portrait";
  /** Keyframe image bytes by filename. */
  keyframes: ReadonlyMap<string, Uint8Array>;
  createGenerator: (candidate: VideoCandidate) => VideoGenerator;
  measure?: (
    bytes: Uint8Array,
    mimeType: string,
  ) => Promise<Readonly<{ probe: ClipProbe; meanFrameDiff: number | null }>>;
  onRow?: (row: VideoBenchRow) => void;
}>;

const measureVideo: NonNullable<VideoBenchOptions["measure"]> = async (bytes, mimeType) => ({
  probe: await probeVideo(bytes, mimeType),
  meanFrameDiff: await meanFrameDiff(bytes, mimeType).catch(() => null),
});

export const runVideoBench = async (
  candidates: readonly VideoCandidate[],
  options: VideoBenchOptions,
): Promise<readonly VideoBenchRow[]> => {
  const rows: VideoBenchRow[] = [];
  const push = (r: VideoBenchRow) => {
    rows.push(r);
    options.onRow?.(r);
  };
  const measure = options.measure ?? measureVideo;
  for (const candidate of candidates) {
    const refusal = videoCandidateRefusal(candidate.model);
    if (refusal) {
      push(row(candidate, "all", { error: refusal }));
      continue;
    }
    let generator: VideoGenerator;
    try {
      generator = options.createGenerator(candidate);
    } catch (error) {
      push(row(candidate, "all", { error: errorCode(error) }));
      continue;
    }
    for (const keyframe of KEYFRAMES) {
      const reference = options.keyframes.get(keyframe.file);
      for (const frames of FRAME_COUNTS) {
        const profile: LocalClipProfile | null = localClipProfile({
          canvas: options.canvas,
          seconds: frames / 16,
          steps: candidate.steps,
        });
        if (!profile || profile.frames !== frames || !isLocalClipProfile(profile)) {
          push(row(candidate, keyframe.id, { frames, error: "profile_invalid" }));
          continue;
        }
        const base = {
          resolution: `${profile.width}x${profile.height}`,
          frames: profile.frames,
          fps: profile.fps,
          steps: profile.steps,
        };
        if (!reference) {
          push(row(candidate, keyframe.id, { ...base, error: "keyframe_missing" }));
          continue;
        }
        const started = performance.now();
        try {
          const clip = await generator.generate({
            prompt: keyframe.prompt,
            negativePrompt: NEGATIVE,
            reference,
            profile,
            seed: 1,
          });
          const wallMs = Math.round(performance.now() - started);
          const measured = await measure(clip.bytes, clip.mimeType).catch(() => null);
          const probe = measured?.probe;
          push(
            row(candidate, keyframe.id, {
              ...base,
              wallMs,
              outputBytes: clip.bytes.byteLength,
              decodeValid: Boolean(probe?.readable && probe.hasVideo && probe.decodeErrors === 0),
              frameCount: probe?.frameCount ?? null,
              corruptFrames: probe?.decodeErrors ?? null,
              meanFrameDiff: measured?.meanFrameDiff ?? null,
            }),
          );
        } catch (error) {
          push(
            row(candidate, keyframe.id, {
              ...base,
              wallMs: Math.round(performance.now() - started),
              error: errorCode(error),
            }),
          );
        }
      }
    }
  }
  return rows;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export const summarizeVideoBench = (rows: readonly VideoBenchRow[]) => ({
  promoted: false as const,
  note: "Evidence only. Promotion is the owner flipping enabled in model-policy; VRAM, RAM, drift, motion quality and scores are filled in by hand.",
  models: [...new Set(rows.map((r) => r.model))].map((model) => {
    const own = rows.filter((r) => r.model === model);
    const times = own
      .filter((r) => r.error === null && r.wallMs !== null)
      .map((r) => r.wallMs as number)
      .sort((a, b) => a - b);
    return {
      model,
      policyEnabled: own[0]?.policyEnabled ?? null,
      rows: own.length,
      failures: own.filter((r) => r.error !== null).length,
      decodeInvalid: own.filter((r) => r.error === null && !r.decodeValid).length,
      p50WallMs: percentile(times, 0.5),
      p95WallMs: percentile(times, 0.95),
      promoted: false as const,
    };
  }),
});

const flag = (args: readonly string[], name: string): string | undefined => {
  const joined = args.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const dir = flag(args, "keyframes");
  if (!dir) throw new Error("video_bench_keyframes_required");
  const canvas = flag(args, "canvas") ?? "landscape";
  if (canvas !== "landscape" && canvas !== "portrait")
    throw new Error("video_bench_canvas_invalid");
  const out = join(
    flag(args, "out") ?? "video-bench-out",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  const keyframes = new Map<string, Uint8Array>();
  for (const keyframe of KEYFRAMES)
    keyframes.set(keyframe.file, new Uint8Array(await readFile(join(dir, keyframe.file))));
  const candidates = readVideoBenchCandidates(process.env);
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  const rows = await runVideoBench(candidates, {
    canvas,
    keyframes,
    // allowDisabled: the bench is how a model earns promotion; the adapter still checks the capability.
    createGenerator: (c) =>
      createSdCppVideoGenerator({
        baseUrl: c.baseUrl,
        model: c.model,
        allowDisabled: true,
        timeoutMs: Number(process.env.LOCAL_AI_REQUEST_TIMEOUT_MS) || 900_000,
        maxBytes: Number(process.env.LOCAL_AI_MAX_VIDEO_BYTES) || 50_000_000,
      }),
    onRow: (r) => {
      lines.push(JSON.stringify(r));
      console.log(lines.at(-1));
    },
  });
  await writeFile(join(out, "rows.jsonl"), `${lines.join("\n")}\n`);
  const summary = summarizeVideoBench(rows);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("video-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "video bench failed");
    process.exitCode = 1;
  });
}
