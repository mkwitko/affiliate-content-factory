import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import {
  IMAGE_BENCH_CORPUS,
  type ImageBenchCase,
} from "@money-maker/core/explainer/fixtures/image-bench-corpus";
import { lumaStdev, reencodeImage } from "@money-maker/providers/http/fit-image";
import {
  createSdCppSceneGenerator,
  SDCPP_CACHE_MODES,
} from "@money-maker/providers/media/sdcpp-scene-generator";

/**
 * D1: local image benchmark against stable-diffusion.cpp servers. Results are evidence for a
 * human decision: `promoted` is always false. Images stay in the out dir (git-ignored), never
 * in the database or object storage. VRAM/RAM, human and VLM scores are filled in by hand.
 */
export type Candidate = Readonly<{
  baseUrl: string;
  model: string;
  runtime: string;
  quantization: string | null;
  steps: number | null;
  cacheMode: string | null;
}>;

export type BenchRow = Readonly<{
  model: string;
  runtime: string;
  quantization: string | null;
  caseId: string | null;
  seed: number | null;
  run: number | null;
  width: number | null;
  height: number | null;
  steps: number | null;
  /** True for the first generation per candidate: includes any server-side model load. */
  firstRequest: boolean;
  wallMs: number | null;
  outputBytes: number | null;
  decodeValid: boolean;
  dimensionsValid: boolean;
  corrupt: boolean;
  reencodeOk: boolean;
  /** Heuristic only: luma stdev above a small floor, so not a blank or uniform picture. */
  deterministicQa: boolean;
  peakVramMb: null;
  peakRamMb: null;
  humanScore: null;
  vlmScore: null;
  error: string | null;
}>;

// Owner decision 2026-10-05: plates are generated once, overnight, and reused, so the RX 6650 XT's
// ~410 s per 768x1344 plate is acceptable; the gate is 10 minutes per plate (was 180 s).
const MAX_PLATE_SEC = 600;
/** A candidate that fails this many plates in a row is abandoned: a dead runtime, not a model result. */
const MAX_CONSECUTIVE_FAILURES = 3;
const MIN_LUMA_STDEV = 4;

// Hand validation, like director-bench: the worker has no zod dependency.
export const readImageBenchCandidates = (
  env: Readonly<Record<string, string | undefined>>,
): readonly Candidate[] => {
  let value: unknown;
  try {
    value = JSON.parse(env.IMAGE_BENCH_CANDIDATES ?? "");
  } catch {
    throw new Error("image_bench_candidates_invalid");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new Error("image_bench_candidates_invalid");
  return value.map((item: unknown) => {
    const c = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (
      typeof c.baseUrl !== "string" ||
      typeof c.model !== "string" ||
      typeof c.runtime !== "string" ||
      (c.quantization != null && typeof c.quantization !== "string") ||
      (c.steps != null && !Number.isInteger(c.steps)) ||
      (c.cacheMode != null && !(SDCPP_CACHE_MODES as readonly unknown[]).includes(c.cacheMode))
    )
      throw new Error("image_bench_candidates_invalid");
    return {
      baseUrl: c.baseUrl,
      model: c.model,
      runtime: c.runtime,
      quantization: (c.quantization as string | null | undefined) ?? null,
      steps: (c.steps as number | null | undefined) ?? null,
      cacheMode: (c.cacheMode as string | null | undefined) ?? null,
    };
  });
};

const row = (
  candidate: Candidate,
  over: { -readonly [K in keyof BenchRow]?: BenchRow[K] },
): BenchRow => ({
  model: candidate.model,
  runtime: candidate.runtime,
  quantization: candidate.quantization,
  caseId: null,
  seed: null,
  run: null,
  width: null,
  height: null,
  steps: candidate.steps,
  firstRequest: false,
  wallMs: null,
  outputBytes: null,
  decodeValid: false,
  dimensionsValid: false,
  corrupt: false,
  reencodeOk: false,
  deterministicQa: false,
  peakVramMb: null,
  peakRamMb: null,
  humanScore: null,
  vlmScore: null,
  error: null,
  ...over,
});

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
    ? error.message
    : "generation_failed";

/** Refuses anything the server-owned policy does not list as a commercial image generator. */
export const candidateRefusal = (model: string): string | null => {
  const policy = modelPolicyFor(model);
  if (!policy) return "model_not_allowed";
  if (policy.capability !== "image_generation") return "model_not_image_generation";
  if (policy.licensePolicy === "research_only") return "model_license_research_only";
  return null;
};

export type BenchOptions = Readonly<{
  runs: number;
  cases: readonly ImageBenchCase[];
  createGenerator: (candidate: Candidate) => SceneGenerator;
  onImage?: (candidate: Candidate, name: string, bytes: Uint8Array) => Promise<void>;
  onRow?: (row: BenchRow) => void;
}>;

export const runImageBench = async (
  candidates: readonly Candidate[],
  options: BenchOptions,
): Promise<readonly BenchRow[]> => {
  const rows: BenchRow[] = [];
  const push = (r: BenchRow) => {
    rows.push(r);
    options.onRow?.(r);
  };
  for (const candidate of candidates) {
    const refusal = candidateRefusal(candidate.model);
    if (refusal) {
      push(row(candidate, { error: refusal }));
      continue;
    }
    let generator: SceneGenerator;
    try {
      generator = options.createGenerator(candidate);
    } catch (error) {
      push(row(candidate, { error: errorCode(error) }));
      continue;
    }
    let first = true;
    let failures = 0;
    for (const item of options.cases)
      for (const seed of item.seeds)
        for (let run = 1; run <= options.runs; run += 1) {
          if (failures >= MAX_CONSECUTIVE_FAILURES) break;
          const base = {
            caseId: item.id,
            seed,
            run,
            width: item.width,
            height: item.height,
            firstRequest: first,
          };
          first = false;
          const started = performance.now();
          try {
            // Same prompt and pinned seed for every candidate and run: repeats test stability.
            const image = await generator.generate(
              item.prompt,
              { width: item.width, height: item.height },
              { seed },
            );
            const wallMs = Math.round(performance.now() - started);
            failures = 0;
            const decoded = await reencodeImage(image.bytes).catch(() => null);
            const stdev = decoded ? await lumaStdev(image.bytes).catch(() => 0) : 0;
            push(
              row(candidate, {
                ...base,
                wallMs,
                outputBytes: image.bytes.byteLength,
                decodeValid: decoded !== null,
                dimensionsValid:
                  decoded !== null &&
                  decoded.width === item.width &&
                  decoded.height === item.height,
                corrupt: decoded === null,
                reencodeOk: decoded !== null && decoded.bytes.byteLength > 0,
                deterministicQa: stdev > MIN_LUMA_STDEV,
              }),
            );
            if (decoded)
              await options
                .onImage?.(candidate, `${item.id}-${seed}-${run}.png`, image.bytes)
                .catch(() => undefined);
          } catch (error) {
            const code = errorCode(error);
            failures += 1;
            push(
              row(candidate, {
                ...base,
                wallMs: Math.round(performance.now() - started),
                corrupt: code === "sdcpp_image_invalid",
                error: code,
              }),
            );
          }
        }
  }
  return rows;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export const summarizeImageBench = (rows: readonly BenchRow[], runs: number) => {
  const models = [...new Set(rows.map((r) => r.model))];
  return {
    promoted: false as const,
    note: "firstRequest wall time includes any model load, but true load time is not observable over HTTP. VRAM, RAM and scores are manual.",
    models: models.map((model) => {
      const own = rows.filter((r) => r.model === model);
      const generated = own.filter((r) => r.error === null && r.wallMs !== null);
      const times = generated.map((r) => r.wallMs as number).sort((a, b) => a - b);
      const p95 = percentile(times, 0.95);
      const corrupt = own.filter((r) => r.corrupt).length;
      const failures = own.filter((r) => r.error !== null || r.corrupt).length;
      return {
        model,
        rows: own.length,
        failures,
        corrupt,
        p50WallMs: percentile(times, 0.5),
        p95WallMs: p95,
        gate: {
          maxPlateSec: MAX_PLATE_SEC,
          runsPerCase: runs,
          passLatency: p95 !== null && p95 <= MAX_PLATE_SEC * 1000,
          zeroCorruptInRuns: generated.length > 0 && corrupt === 0,
          noCrash: failures === 0,
          reencodeOk: generated.length > 0 && generated.every((r) => r.reencodeOk),
          humanReviewPending: true,
        },
        promoted: false as const,
      };
    }),
  };
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const selectCases = (ids: string | undefined): readonly ImageBenchCase[] => {
  if (!ids) return IMAGE_BENCH_CORPUS;
  const wanted = ids.split(",").map((s) => s.trim());
  const chosen = IMAGE_BENCH_CORPUS.filter((c) => wanted.includes(c.id));
  if (chosen.length !== wanted.length) throw new Error("image_bench_case_unknown");
  return chosen;
};

/** `--size=512x896` renders every selected case at that size instead (64-aligned, 512-2048). */
export const resizeCases = (
  cases: readonly ImageBenchCase[],
  size: string | undefined,
): readonly ImageBenchCase[] => {
  if (!size) return cases;
  const match = /^(\d+)x(\d+)$/.exec(size);
  const [width, height] = [Number(match?.[1]), Number(match?.[2])];
  if (
    !match ||
    ![width, height].every((n) => Number.isInteger(n) && n % 64 === 0 && n >= 512 && n <= 2048)
  )
    throw new Error("image_bench_size_invalid");
  return cases.map((c) => ({ ...c, id: `${c.id}@${width}x${height}`, width, height }));
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const runs = Number(flag(args, "runs") ?? 1);
  if (!Number.isInteger(runs) || runs < 1 || runs > 50) throw new Error("image_bench_runs_invalid");
  const out = flag(args, "out") ?? "image-bench-out";
  const cases = resizeCases(selectCases(flag(args, "cases")), flag(args, "size"));
  // Above the 180 s gate on purpose: a slow plate is measured, not cut off.
  const timeoutSec = Number(flag(args, "timeout-sec") ?? 600);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 3600)
    throw new Error("image_bench_timeout_invalid");
  const candidates = readImageBenchCandidates(process.env);
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  const rows = await runImageBench(candidates, {
    runs,
    cases,
    // The adapter enforces the loopback/private URL rule and the policy `enabled` flag.
    createGenerator: (c) =>
      createSdCppSceneGenerator({
        baseUrl: c.baseUrl,
        model: c.model,
        timeoutMs: timeoutSec * 1000,
        ...(c.steps != null ? { steps: c.steps } : {}),
        ...(c.cacheMode ? { cacheMode: c.cacheMode as (typeof SDCPP_CACHE_MODES)[number] } : {}),
      }),
    onImage: async (c, name, bytes) => {
      const dir = join(out, "images", c.model.replace(/[^\w.-]/g, "_"));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, name), bytes);
    },
    onRow: (r) => {
      lines.push(JSON.stringify(r));
      console.log(lines.at(-1));
    },
  });
  await writeFile(join(out, "rows.jsonl"), `${lines.join("\n")}\n`);
  const summary = summarizeImageBench(rows, runs);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("image-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "image bench failed");
    process.exitCode = 1;
  });
}
