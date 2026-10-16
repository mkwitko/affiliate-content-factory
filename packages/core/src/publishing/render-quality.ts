import type { NarrationCheck } from "./narration-check.js";

/**
 * Post-render quality gate: grades what ffprobe/ffmpeg measured on a rendered MP4 against what
 * the renderer planned. Pure, so thresholds are unit-tested; the measurement lives in providers.
 * A render is never "pass" on a check that was not measured: unmeasured checks are "n/a".
 */
export type TimeRange = Readonly<{ startMs: number; endMs: number }>;
export type RenderStats = Readonly<{
  readable: boolean;
  decodeErrors: number;
  video?:
    | Readonly<{ codec: string; pixelFormat: string; width: number; height: number; fps: number }>
    | undefined;
  hasAudio: boolean;
  durationMs: number;
  integratedLufs?: number | undefined;
  truePeakDbtp?: number | undefined;
  silences: readonly TimeRange[];
  blacks: readonly TimeRange[];
  freezes: readonly TimeRange[];
}>;
export type RenderExpectations = Readonly<{
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  audioRequired: boolean;
  /** Intended still frames (static slides), intended pauses and intended dark frames. */
  plannedStill: readonly TimeRange[];
  plannedSilence: readonly TimeRange[];
  plannedDark: readonly TimeRange[];
  /** Renderer notes such as action_timing_estimated:3 or action_dropped:2. */
  notes?: readonly string[] | undefined;
}>;
export type QualityVerdict = "pass" | "warn" | "block";
export type QualityCheckId =
  | "container"
  | "dimensions"
  | "fps"
  | "duration"
  | "audio_stream"
  | "loudness"
  | "true_peak"
  | "silence"
  | "black"
  | "freeze"
  | "render_notes"
  | "music";
export type QualityCheck = Readonly<{
  id: QualityCheckId;
  verdict: QualityVerdict | "n/a";
  detail?: string;
}>;
/** Visual QA (v2 slice 28): informational, never changes the verdict; the thumbnail gate blocks earlier. */
export type VisualFinding = Readonly<{
  id: string;
  severity: "INFO" | "WARN" | "BLOCK";
  sceneIndex?: number;
  detail?: string;
}>;
/** VLM key-frame review record (v2 slice 29); `vlm: "skipped"` marks a review that did not run. */
export type VlmRecord = Readonly<{
  vlm: "reviewed" | "skipped";
  reason?: string;
  model?: string;
  latencyMs?: number;
  frames?: number;
  unreadableFrames?: number;
}>;
export type VisualSection = Readonly<{
  findings: readonly VisualFinding[];
  /** Average colour of each scene's key frame, hex. */
  colorStrip: readonly string[];
  vlm?: VlmRecord;
}>;
export type StageCacheCounts = Readonly<{ hit: number; miss: number }>;

export type RenderQualityReport = Readonly<{
  version: 1;
  verdict: QualityVerdict;
  checks: readonly QualityCheck[];
  measuredAt: string;
  visual?: VisualSection;
  /** ASR narration check (home speech_recognition); absent while no home machine ran it. */
  narration?: NarrationCheck;
  /** Per stage, how many stage-cache hits and misses this attempt saw (stage cache spec 3.3). */
  cacheHits?: Readonly<Record<string, StageCacheCounts>>;
}>;

/** Attaches cache counters to a report; a report without counters stays untouched. */
export const withCacheHits = (
  report: RenderQualityReport | undefined,
  cacheHits: Readonly<Record<string, StageCacheCounts>>,
): RenderQualityReport | undefined =>
  report && Object.keys(cacheHits).length > 0 ? { ...report, cacheHits } : report;

/** Adds the narration check; a spoken number the script does not match blocks the report. */
export const withNarrationCheck = (
  report: RenderQualityReport,
  narration: NarrationCheck,
): RenderQualityReport => ({
  ...report,
  verdict: narration.verdict === "block" ? "block" : report.verdict,
  narration,
});

/**
 * Records whether a licensed track was mixed in. A Reel without music renders fine and used to
 * look fine too (owner, 2026-10-08: "music in every Reel"); now it warns, so the operator sees
 * an empty music folder in the review instead of after publishing. Never blocks.
 */
export const withMusicCheck = (
  report: RenderQualityReport | undefined,
  track: boolean | Readonly<{ license?: string }>,
): RenderQualityReport | undefined => {
  if (!report || report.checks.some((entry) => entry.id === "music")) return report;
  // A track from a library without a manifest plays, but its licence is not on record.
  const unrecorded = typeof track === "object" && !track.license;
  const check: QualityCheck = !track
    ? { id: "music", verdict: "warn", detail: "no licensed track available: Reel has no music" }
    : unrecorded
      ? { id: "music", verdict: "warn", detail: "music licence not recorded in the manifest" }
      : { id: "music", verdict: "pass" };
  return {
    ...report,
    verdict: check.verdict === "warn" && report.verdict === "pass" ? "warn" : report.verdict,
    checks: [...report.checks, check],
  };
};

/** Records scenes that rendered a static plate instead of a generated clip: WARN scene_clip_fallback:<i>. */
export const withClipFallbacks = (
  report: RenderQualityReport | undefined,
  sceneIndexes: readonly number[],
): RenderQualityReport | undefined =>
  report && sceneIndexes.length > 0
    ? {
        ...report,
        visual: {
          colorStrip: [],
          ...report.visual,
          findings: [
            ...(report.visual?.findings ?? []),
            ...sceneIndexes.map((sceneIndex) => ({
              id: `scene_clip_fallback:${sceneIndex}`,
              severity: "WARN" as const,
              sceneIndex,
            })),
          ],
        },
      }
    : report;

/** Counts `cached` flags from synthesizer outputs; outputs without the flag are not counted. */
export const countTtsCache = (
  results: readonly Readonly<{ cached?: boolean }>[],
): Readonly<Record<string, StageCacheCounts>> => {
  const seen = results.filter((result) => result.cached !== undefined);
  if (seen.length === 0) return {};
  const hit = seen.filter((result) => result.cached === true).length;
  return { tts: { hit, miss: seen.length - hit } };
};

const CHECK_ORDER: readonly QualityCheckId[] = [
  "container",
  "dimensions",
  "fps",
  "duration",
  "audio_stream",
  "loudness",
  "true_peak",
  "silence",
  "black",
  "freeze",
  "render_notes",
  "music",
];
const rank: Readonly<Record<QualityVerdict | "n/a", number>> = {
  "n/a": 0,
  pass: 0,
  warn: 1,
  block: 2,
};
const sec = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/** Parts of each detected run that no planned range covers. */
export const subtractRanges = (
  detected: readonly TimeRange[],
  planned: readonly TimeRange[],
): readonly TimeRange[] => {
  const sorted = [...planned].sort((a, b) => a.startMs - b.startMs);
  const out: TimeRange[] = [];
  for (const run of detected) {
    let cursor = run.startMs;
    for (const cover of sorted) {
      if (cover.endMs <= cursor || cover.startMs >= run.endMs) continue;
      if (cover.startMs > cursor) out.push({ startMs: cursor, endMs: cover.startMs });
      cursor = Math.max(cursor, cover.endMs);
    }
    if (cursor < run.endMs) out.push({ startMs: cursor, endMs: run.endMs });
  }
  return out;
};

/** The parts of [0, durationMs] no covered range touches, e.g. silence between voice clips. */
export const gapsBetween = (
  covered: readonly TimeRange[],
  durationMs: number,
): readonly TimeRange[] => subtractRanges([{ startMs: 0, endMs: durationMs }], covered);

const length = (range: TimeRange) => range.endMs - range.startMs;
const longest = (ranges: readonly TimeRange[]) => Math.max(0, ...ranges.map(length));
const total = (ranges: readonly TimeRange[]) => ranges.reduce((sum, r) => sum + length(r), 0);

/** Grades unplanned runs: warn from warnMs, block from blockMs or when they cover blockShare. */
const runs = (
  id: QualityCheckId,
  unplanned: readonly TimeRange[],
  durationMs: number,
  limits: Readonly<{ warnMs: number; blockMs: number; blockShare?: number }>,
): QualityCheck => {
  const worst = longest(unplanned);
  const share = durationMs > 0 ? total(unplanned) / durationMs : 0;
  const detail = unplanned.length
    ? `unplanned ${unplanned.length} run(s), longest ${sec(worst)}, ${Math.round(share * 100)}%`
    : undefined;
  const verdict: QualityVerdict =
    worst >= limits.blockMs || (limits.blockShare !== undefined && share >= limits.blockShare)
      ? "block"
      : worst >= limits.warnMs
        ? "warn"
        : "pass";
  return { id, verdict, ...(verdict !== "pass" && detail ? { detail } : {}) };
};

const grade = (stats: RenderStats, expected: RenderExpectations): readonly QualityCheck[] => {
  const video = stats.video;
  if (!stats.readable || !video)
    return CHECK_ORDER.map((id) =>
      id === "container"
        ? { id, verdict: "block" as const, detail: "unreadable or no video stream" }
        : { id, verdict: "n/a" as const, detail: "container unreadable" },
    );
  const checks: QualityCheck[] = [];
  const containerOk =
    video.codec === "h264" && video.pixelFormat === "yuv420p" && stats.decodeErrors === 0;
  checks.push(
    containerOk
      ? { id: "container", verdict: "pass" }
      : {
          id: "container",
          verdict: "block",
          detail: `${video.codec}/${video.pixelFormat}, ${stats.decodeErrors} decode error(s)`,
        },
  );
  checks.push(
    video.width === expected.width && video.height === expected.height
      ? { id: "dimensions", verdict: "pass" }
      : { id: "dimensions", verdict: "block", detail: `${video.width}x${video.height}` },
  );
  checks.push(
    Math.abs(video.fps - expected.fps) <= 0.5
      ? { id: "fps", verdict: "pass" }
      : { id: "fps", verdict: "block", detail: `${video.fps} fps` },
  );
  const drift = Math.abs(stats.durationMs - expected.durationMs);
  const durationVerdict: QualityVerdict =
    drift <= Math.max(500, expected.durationMs * 0.02)
      ? "pass"
      : drift <= Math.max(1_500, expected.durationMs * 0.05)
        ? "warn"
        : "block";
  checks.push({
    id: "duration",
    verdict: durationVerdict,
    ...(durationVerdict !== "pass"
      ? { detail: `${sec(stats.durationMs)} vs ${sec(expected.durationMs)} planned` }
      : {}),
  });
  if (!expected.audioRequired) {
    checks.push({ id: "audio_stream", verdict: stats.hasAudio ? "pass" : "n/a" });
    for (const id of ["loudness", "true_peak", "silence"] as const)
      checks.push({ id, verdict: "n/a", detail: "audio not required" });
  } else if (!stats.hasAudio) {
    checks.push({ id: "audio_stream", verdict: "block", detail: "no audio stream" });
    for (const id of ["loudness", "true_peak", "silence"] as const)
      checks.push({ id, verdict: "n/a", detail: "no audio stream" });
  } else {
    checks.push({ id: "audio_stream", verdict: "pass" });
    const lufs = stats.integratedLufs;
    checks.push(
      lufs === undefined
        ? { id: "loudness", verdict: "n/a", detail: "not measured" }
        : lufs < -30 || lufs > -6
          ? { id: "loudness", verdict: "block", detail: `${lufs} LUFS` }
          : lufs < -16 || lufs > -12
            ? { id: "loudness", verdict: "warn", detail: `${lufs} LUFS` }
            : { id: "loudness", verdict: "pass" },
    );
    const peak = stats.truePeakDbtp;
    checks.push(
      peak === undefined
        ? { id: "true_peak", verdict: "n/a", detail: "not measured" }
        : peak > 0.5
          ? { id: "true_peak", verdict: "block", detail: `${peak} dBTP` }
          : peak > -1
            ? { id: "true_peak", verdict: "warn", detail: `${peak} dBTP` }
            : { id: "true_peak", verdict: "pass" },
    );
    checks.push(
      runs("silence", subtractRanges(stats.silences, expected.plannedSilence), stats.durationMs, {
        warnMs: 1_500,
        blockMs: 4_000,
        blockShare: 0.5,
      }),
    );
  }
  const blacks = subtractRanges(stats.blacks, expected.plannedDark);
  const black = runs("black", blacks, stats.durationMs, { warnMs: 300, blockMs: 1_000 });
  checks.push(
    black.verdict === "pass" && blacks.some((range) => range.startMs <= 0)
      ? { id: "black", verdict: "warn", detail: "black first frame" }
      : black,
  );
  checks.push(
    runs("freeze", subtractRanges(stats.freezes, expected.plannedStill), stats.durationMs, {
      warnMs: 2_000,
      blockMs: 5_000,
      blockShare: 0.6,
    }),
  );
  const notes = expected.notes ?? [];
  checks.push(
    notes.length
      ? { id: "render_notes", verdict: "warn", detail: notes.join(", ").slice(0, 300) }
      : { id: "render_notes", verdict: "pass" },
  );
  return checks;
};

export const evaluateRenderQuality = (
  stats: RenderStats,
  expected: RenderExpectations,
  now: Date = new Date(),
): RenderQualityReport => {
  const checks = grade(stats, expected);
  const worst = checks.reduce<QualityVerdict>(
    (acc, entry) => (rank[entry.verdict] > rank[acc] ? (entry.verdict as QualityVerdict) : acc),
    "pass",
  );
  return Object.freeze({
    version: 1,
    verdict: worst,
    checks: Object.freeze(checks.map((entry) => Object.freeze(entry))),
    measuredAt: now.toISOString(),
  });
};

export const blockingCheckIds = (report: RenderQualityReport): readonly string[] =>
  report.checks.filter((entry) => entry.verdict === "block").map((entry) => entry.id);

/** The render-failure reason for a blocked report (quality_blocked:<check ids>), else undefined. */
export const qualityBlockReason = (report: RenderQualityReport | undefined): string | undefined =>
  report?.verdict === "block" ? `quality_blocked:${blockingCheckIds(report).join(",")}` : undefined;

/** The checks an operator needs to see: everything that is not a plain pass. */
export const qualitySummary = (report: RenderQualityReport) => ({
  verdict: report.verdict,
  checks: report.checks.filter((entry) => entry.verdict === "warn" || entry.verdict === "block"),
  ...(report.narration ? { narration: report.narration } : {}),
});

const verdicts: readonly string[] = ["pass", "warn", "block"];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseVlmRecord = (value: unknown): VlmRecord | undefined => {
  if (!isRecord(value) || (value.vlm !== "reviewed" && value.vlm !== "skipped")) return undefined;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
  const latencyMs = count(value.latencyMs);
  const frames = count(value.frames);
  const unreadableFrames = count(value.unreadableFrames);
  return Object.freeze({
    vlm: value.vlm,
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 100) } : {}),
    ...(typeof value.model === "string" ? { model: value.model.slice(0, 100) } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(frames !== undefined ? { frames } : {}),
    ...(unreadableFrames !== undefined ? { unreadableFrames } : {}),
  });
};

const parseVisualSection = (value: unknown): VisualSection | undefined => {
  if (!isRecord(value) || !Array.isArray(value.findings) || !Array.isArray(value.colorStrip))
    return undefined;
  const findings: VisualFinding[] = [];
  for (const entry of value.findings) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !["INFO", "WARN", "BLOCK"].includes(String(entry.severity))
    )
      return undefined;
    findings.push({
      id: entry.id,
      severity: entry.severity as VisualFinding["severity"],
      ...(typeof entry.sceneIndex === "number" ? { sceneIndex: entry.sceneIndex } : {}),
      ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
    });
  }
  const colorStrip = value.colorStrip.filter((hex): hex is string => typeof hex === "string");
  const vlm = parseVlmRecord(value.vlm);
  return Object.freeze({
    findings: Object.freeze(findings),
    colorStrip: Object.freeze(colorStrip),
    ...(vlm ? { vlm } : {}),
  });
};

/** Reads a report stored as JSON; anything malformed reads as "not measured". */
const parseCacheHits = (value: unknown): Readonly<Record<string, StageCacheCounts>> | undefined => {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    ([, counts]) =>
      isRecord(counts) && Number.isSafeInteger(counts.hit) && Number.isSafeInteger(counts.miss),
  );
  return entries.length > 0
    ? Object.fromEntries(
        entries.map(([stage, counts]) => {
          const { hit, miss } = counts as StageCacheCounts;
          return [stage, { hit, miss }];
        }),
      )
    : undefined;
};

const parseNarration = (value: unknown): NarrationCheck | undefined => {
  if (
    !isRecord(value) ||
    (value.verdict !== "pass" && value.verdict !== "block") ||
    typeof value.wer !== "number" ||
    !Array.isArray(value.missing) ||
    typeof value.model !== "string" ||
    typeof value.checkedAt !== "string"
  )
    return undefined;
  return Object.freeze({
    verdict: value.verdict,
    wer: value.wer,
    missing: Object.freeze(value.missing.filter((m): m is string => typeof m === "string")),
    model: value.model,
    checkedAt: value.checkedAt,
  });
};

export const parseRenderQualityReport = (value: unknown): RenderQualityReport | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.verdict !== "string" ||
    !verdicts.includes(value.verdict) ||
    typeof value.measuredAt !== "string" ||
    !Array.isArray(value.checks)
  )
    return undefined;
  const checks: QualityCheck[] = [];
  for (const entry of value.checks) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !CHECK_ORDER.includes(entry.id as QualityCheckId) ||
      typeof entry.verdict !== "string" ||
      ![...verdicts, "n/a"].includes(entry.verdict)
    )
      return undefined;
    checks.push(
      Object.freeze({
        id: entry.id as QualityCheckId,
        verdict: entry.verdict as QualityCheck["verdict"],
        ...(typeof entry.detail === "string" ? { detail: entry.detail } : {}),
      }),
    );
  }
  const visual = parseVisualSection(value.visual);
  const cacheHits = parseCacheHits(value.cacheHits);
  const narration = parseNarration(value.narration);
  return Object.freeze({
    version: 1,
    verdict: value.verdict as QualityVerdict,
    checks: Object.freeze(checks),
    measuredAt: value.measuredAt,
    ...(visual ? { visual } : {}),
    ...(narration ? { narration } : {}),
    ...(cacheHits ? { cacheHits } : {}),
  });
};
