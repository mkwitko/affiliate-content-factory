import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { DirectAttempt } from "@money-maker/core/content/direct-scenes";
import { composeSceneSvg } from "@money-maker/core/explainer/compose-scene";
import {
  DEFAULT_SCENE_PALETTE,
  readExplainerContext,
} from "@money-maker/core/explainer/explainer-context";
import { FRAME } from "@money-maker/core/explainer/layout";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { rasterizeSvg } from "@money-maker/providers/media/svg-rasterizer";
import { REVIEW_SCALE, reviewSheetFor } from "./director-review-init.js";
import { reviewPackHtml } from "./director-review-pack-page.js";

/**
 * Builds an offline visual review pack from a director benchmark JSON: one still per accepted
 * SceneSpec, composed and rasterized exactly as preview_video_storyboard does (composeSceneSvg
 * at FRAME size), plus a static page that fills the human review sheet and exports it as JSON.
 * It reads the benchmark and an optional review sheet and writes only inside the pack folder:
 * no database, no object storage, no scene director call.
 */
export const DEFAULT_PACK_DIR = "director-review-pack";
const PACK_KIND = "director-review-pack";

export const REVIEW_FIELDS = [
  "story_coherence",
  "scene_continuity",
  "visual_specificity",
  "product_visibility",
  "character_consistency",
  "commercial_intent",
  "editorial_decision",
  "manual_fix_minutes",
  "notes",
] as const;

/**
 * Null when `value` is allowed for a human review field. Self-contained on purpose: the review
 * page embeds this function's source, so the page and this command share one rule set.
 */
export const reviewValueError = (field: string, value: unknown): string | null => {
  const scores = [1, 2, 3, 4, 5];
  if (field === "notes") return typeof value === "string" ? null : "notes must be a string";
  if (value === null) return null;
  switch (field) {
    case "story_coherence":
    case "scene_continuity":
    case "visual_specificity":
    case "character_consistency":
    case "commercial_intent":
      return scores.includes(value as number) ? null : `${field} must be 1-5 or null`;
    case "product_visibility":
      return value === "n/a" || scores.includes(value as number)
        ? null
        : `${field} must be 1-5, "n/a" or null`;
    case "editorial_decision":
      return ["pass", "needs_fix", "fail"].includes(value as string)
        ? null
        : `${field} must be pass, needs_fix, fail or null`;
    case "manual_fix_minutes":
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? null
        : `${field} must be a number >= 0 or null`;
    default:
      return `unknown review field ${field}`;
  }
};

type BenchRun = Readonly<{
  fixture: Readonly<{
    id: string;
    source: string;
    language: string;
    body: string;
    claims?: readonly unknown[];
    beats?: readonly unknown[];
    cast?: readonly string[];
    characters?: readonly unknown[];
  }>;
  result: Readonly<{
    ok: boolean;
    reason?: string;
    scenes?: readonly SceneSpec[];
    attempts: readonly DirectAttempt[];
  }>;
  latencyMs: number;
}>;
type BenchCase = Readonly<{
  case_id: string;
  accepted: boolean;
  retry_count: number;
  latency_ms: number;
  validation_failures: readonly string[];
}>;
export type Bench = Readonly<{
  model: string;
  split: string;
  candidate?: Readonly<{ runtime?: string; quantization?: string | null }>;
  provenance?: Readonly<{ modelVerified?: boolean }> & Record<string, unknown>;
  gate?: Record<string, unknown>;
  runs: readonly BenchRun[];
  cases: readonly BenchCase[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks the fields this command reads; anything else in the benchmark is passed through. */
export const parseBench = (value: unknown, path: string): Bench => {
  const invalid = new Error(`${path} is not a director-bench result`);
  if (!isRecord(value) || typeof value.model !== "string" || typeof value.split !== "string")
    throw invalid;
  if (!Array.isArray(value.runs) || !Array.isArray(value.cases)) throw invalid;
  for (const run of value.runs) {
    if (!isRecord(run) || !isRecord(run.fixture) || !isRecord(run.result)) throw invalid;
    const { fixture, result } = run;
    if (typeof fixture.id !== "string" || typeof fixture.body !== "string") throw invalid;
    if (typeof result.ok !== "boolean" || !Array.isArray(result.attempts)) throw invalid;
    if (result.ok && !Array.isArray(result.scenes)) throw invalid;
  }
  for (const item of value.cases)
    if (!isRecord(item) || typeof item.case_id !== "string") throw invalid;
  return value as unknown as Bench;
};

type ReviewCase = Record<string, unknown> & { case_id: string };
export type ReviewSheet = Record<string, unknown> & { cases: readonly ReviewCase[] };

/**
 * Validates a review sheet against the benchmark: every case id must exist there and every
 * human field must hold an allowed value. Benchmark cases the sheet lacks get empty entries.
 */
export const parseReviewSheet = (value: unknown, bench: Bench, path: string): ReviewSheet => {
  if (!isRecord(value) || !Array.isArray(value.cases))
    throw new Error(`${path} is not a director review sheet`);
  const ids = new Set(bench.cases.map((item) => item.case_id));
  const byId = new Map<string, ReviewCase>();
  for (const item of value.cases) {
    if (!isRecord(item) || typeof item.case_id !== "string" || !ids.has(item.case_id))
      throw new Error(`${path}: review case is not in the benchmark`);
    for (const field of REVIEW_FIELDS) {
      const error = reviewValueError(field, item[field]);
      if (error) throw new Error(`${path}: ${item.case_id}: ${error}`);
    }
    byId.set(item.case_id, item as ReviewCase);
  }
  const template = reviewSheetFor(bench, "", new Date(0)).cases;
  return {
    ...value,
    cases: template.map((empty) => byId.get(empty.case_id) ?? empty),
  };
};

/** A case folder name: its position (unique, ordered) and a filesystem-safe slice of its id. */
export const caseDirName = (position: number, caseId: string): string =>
  `${String(position + 1).padStart(2, "0")}-${caseId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}`;

export type PackScene = Readonly<{
  position: number;
  image: string | null;
  error: string | null;
  script: string;
  spec: SceneSpec;
}>;
/**
 * One storyboard under review. `id` is an opaque label ("A"); a later blind comparison adds a
 * second candidate per case and hides `provenance` until the sheet is exported.
 */
export type PackCandidate = Readonly<{
  id: string;
  provenance: Readonly<{
    model: string;
    runtime: string | null;
    quantization: string | null;
    modelVerified: boolean | null;
  }>;
  accepted: boolean;
  retry_count: number;
  latency_ms: number;
  failure_reason: string | null;
  validation_failures: readonly string[];
  attempts: readonly DirectAttempt[];
  scenes: readonly PackScene[];
}>;
export type PackCase = Readonly<{
  case_id: string;
  source: string | null;
  language: string;
  body: string;
  claims: readonly unknown[];
  beats: readonly unknown[];
  cast: readonly string[];
  candidates: readonly PackCandidate[];
}>;
export type PackManifest = Readonly<{
  kind: typeof PACK_KIND;
  version: 1;
  benchmark: string;
  model: string;
  split: string;
  frame: Readonly<{ width: number; height: number }>;
  scale: typeof REVIEW_SCALE;
  gate: Record<string, unknown> | null;
  cases: readonly PackCase[];
}>;
export type ReviewPack = Readonly<{
  manifest: PackManifest;
  review: ReviewSheet;
  images: ReadonlyMap<string, Uint8Array>;
}>;
export type Rasterize = (
  svg: string,
  size: Readonly<{ width: number; height: number }>,
) => Promise<Uint8Array>;

/**
 * Composes every final scene of every benchmark run, in benchmark order. The fixtures carry the
 * cast the director saw but no niche brand kit, so the palette is the default one
 * scenePaletteFor gives a niche without a brand accent.
 */
export const buildReviewPack = async (
  bench: Bench,
  benchmarkPath: string,
  review: ReviewSheet,
  rasterize: Rasterize,
): Promise<ReviewPack> => {
  const images = new Map<string, Uint8Array>();
  const cases: PackCase[] = [];
  for (const [position, run] of bench.runs.entries()) {
    const { fixture, result } = run;
    const benchCase = bench.cases.find((item) => item.case_id === fixture.id);
    const dir = `cases/${caseDirName(position, fixture.id)}`;
    const characters =
      readExplainerContext({ kind: "media", context: { characters: fixture.characters ?? [] } })
        ?.characters ?? [];
    const context = { characters, palette: DEFAULT_SCENE_PALETTE };
    const scenes: PackScene[] = [];
    for (const [index, spec] of (result.ok ? (result.scenes ?? []) : []).entries()) {
      const script = fixture.body.slice(spec.fromChar, spec.toChar);
      let svg: string;
      try {
        svg = composeSceneSvg(spec, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : "compose_failed";
        scenes.push({ position: index, image: null, error: message, script, spec });
        continue;
      }
      const image = `${dir}/scene-${String(index + 1).padStart(2, "0")}.png`;
      images.set(image, await rasterize(svg, FRAME));
      scenes.push({ position: index, image, error: null, script, spec });
    }
    cases.push({
      case_id: fixture.id,
      source: fixture.source ?? null,
      language: fixture.language,
      body: fixture.body,
      claims: fixture.claims ?? [],
      beats: fixture.beats ?? [],
      cast: fixture.cast ?? [],
      candidates: [
        {
          id: "A",
          provenance: {
            model: bench.model,
            runtime: bench.candidate?.runtime ?? null,
            quantization: bench.candidate?.quantization ?? null,
            modelVerified: bench.provenance?.modelVerified ?? null,
          },
          accepted: result.ok,
          retry_count: benchCase?.retry_count ?? result.attempts.length,
          latency_ms: benchCase?.latency_ms ?? run.latencyMs,
          failure_reason: result.ok ? null : (result.reason ?? null),
          validation_failures: benchCase?.validation_failures ?? [],
          attempts: result.attempts,
          scenes,
        },
      ],
    });
  }
  return {
    manifest: {
      kind: PACK_KIND,
      version: 1,
      benchmark: benchmarkPath,
      model: bench.model,
      split: bench.split,
      frame: FRAME,
      scale: REVIEW_SCALE,
      gate: bench.gate ?? null,
      cases,
    },
    review,
    images,
  };
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Writes inside `outDir` only; replaces an earlier pack but never a folder that is not one. */
export const writeReviewPack = async (outDir: string, pack: ReviewPack): Promise<void> => {
  const root = resolve(outDir);
  let entries: string[] | null = null;
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (entries && entries.length > 0) {
    let kind: unknown;
    try {
      kind = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).kind;
    } catch {
      kind = null;
    }
    if (kind !== PACK_KIND)
      throw new Error(`${outDir} is not empty and is not a review pack; choose another folder`);
    await rm(root, { recursive: true });
  }
  const inside = (relative: string): string => {
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep)) throw new Error(`path escapes the pack: ${relative}`);
    return path;
  };
  await mkdir(root, { recursive: true });
  for (const [relative, bytes] of pack.images) {
    const path = inside(relative);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(inside("manifest.json"), json(pack.manifest));
  await writeFile(inside("review.json"), json(pack.review));
  await writeFile(
    inside("index.html"),
    reviewPackHtml(pack.manifest, pack.review, reviewValueError.toString()),
  );
};

/** Starts from `<benchmark>.review.json` when it exists, else from a fresh review-init sheet. */
export const runReviewPack = async (
  benchmarkPath: string,
  outDir: string,
  rasterize: Rasterize,
  now: Date = new Date(),
): Promise<Readonly<{ outDir: string; cases: number; scenes: number; review: string | null }>> => {
  const bench = parseBench(JSON.parse(await readFile(benchmarkPath, "utf8")), benchmarkPath);
  const reviewPath = benchmarkPath.replace(/\.json$/, ".review.json");
  let review: ReviewSheet;
  let reviewSource: string | null = reviewPath;
  try {
    review = parseReviewSheet(JSON.parse(await readFile(reviewPath, "utf8")), bench, reviewPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    review = reviewSheetFor(bench, benchmarkPath, now);
    reviewSource = null;
  }
  const pack = await buildReviewPack(bench, benchmarkPath, review, rasterize);
  await writeReviewPack(outDir, pack);
  return {
    outDir,
    cases: pack.manifest.cases.length,
    scenes: pack.images.size,
    review: reviewSource,
  };
};

const USAGE = "usage: director-review-pack.js <benchmark.json> [outDir]";

const main = async (): Promise<void> => {
  const [benchmarkPath, outDir = DEFAULT_PACK_DIR] = process.argv
    .slice(2)
    .filter((arg) => arg !== "--");
  if (!benchmarkPath?.endsWith(".json")) throw new Error(USAGE);
  const result = await runReviewPack(benchmarkPath, outDir, rasterizeSvg);
  console.log(JSON.stringify({ ...result, open: join(outDir, "index.html") }));
};

if (process.argv[1]?.endsWith("director-review-pack.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "director review pack failed");
    process.exitCode = 1;
  });
}
