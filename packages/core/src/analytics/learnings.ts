import type { ChannelKind } from "../channels/channel.js";
import { learningFeatures, type LearningFeature } from "../content/content.js";
import type { PostMetrics } from "./performance.js";

export type Platform = "instagram" | "youtube" | "tiktok" | "threads";
export type CheckpointDays = 1 | 3 | 7 | 30;

/** One published post read at one checkpoint, joined with its creative choices and clicks. */
export type CheckpointObservation = Readonly<{
  contentVariantId: string;
  channelId: string;
  channelKind: ChannelKind;
  publishedAt: Date | null;
  observedAt: Date;
  metrics: PostMetrics;
  creativeFeatures: unknown;
  /** Null when the variant has no tracked link, so click rate is unknowable rather than zero. */
  uniqueClicks: number | null;
}>;

export const platformOf = (kind: ChannelKind): Platform =>
  kind === "youtube"
    ? "youtube"
    : kind === "threads"
      ? "threads"
      : kind.startsWith("tiktok")
        ? "tiktok"
        : "instagram";

type MetricName = keyof PostMetrics | "clickRate";
/** Target until revenue exists (spec 3.3): first metric in the list that has data wins. */
export const metricOrder: Readonly<Record<Platform, readonly MetricName[]>> = {
  instagram: ["shares", "saves", "clickRate", "reach"],
  youtube: ["averageViewPercentage", "subscribersGained", "clickRate"],
  tiktok: ["shares", "views"],
  threads: ["clickRate", "comments"],
};

export const MIN_ARM_OBSERVATIONS = 8;

const metricValue = (row: CheckpointObservation, metric: MetricName): number | null => {
  if (metric === "clickRate") {
    const audience = row.metrics.reach ?? row.metrics.views;
    return audience && row.uniqueClicks !== null ? row.uniqueClicks / audience : null;
  }
  return row.metrics[metric] ?? null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export const durationBand = (seconds: number): string =>
  seconds < 15
    ? "<15s"
    : seconds < 30
      ? "15-30s"
      : seconds < 60
        ? "30-60s"
        : seconds < 180
          ? "60-180s"
          : "180s+";

/** The arm a post belongs to for one feature, or null when it does not carry that feature. */
export const armOf = (
  row: Pick<CheckpointObservation, "creativeFeatures" | "publishedAt">,
  feature: LearningFeature,
): string | null => {
  const features = asRecord(row.creativeFeatures);
  if (feature === "durationBand")
    return typeof features.durationSec === "number" ? durationBand(features.durationSec) : null;
  if (feature === "publishHour") {
    // ponytail: fixed UTC-3 (Brazil, no DST); make it a channel timezone if other markets join.
    return row.publishedAt ? String((row.publishedAt.getUTCHours() + 21) % 24) : null;
  }
  const value = features[feature];
  return typeof value === "string" || typeof value === "boolean" ? String(value) : null;
};

export type Learning = Readonly<{
  feature: LearningFeature;
  armA: string;
  armB: string;
  metric: string | null;
  platform: Platform;
  checkpoint: string;
  nA: number;
  nB: number;
  /** (meanB - meanA) / meanA * 100; null when meanA is 0. */
  deltaPct: number | null;
  /** The arm with the higher mean when status is "learning". */
  winner?: string;
  status: "learning" | "insufficient_data";
  confidence: "directional";
}>;

const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const variance = (values: readonly number[]) => {
  const m = mean(values);
  return values.length > 1 ? values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1) : 0;
};

export const computeLearnings = (
  rows: readonly CheckpointObservation[],
  options: Readonly<{
    feature: LearningFeature;
    platform: Platform;
    checkpointDays: CheckpointDays;
  }>,
): readonly Learning[] => {
  const scoped = rows.filter((row) => platformOf(row.channelKind) === options.platform);
  // A metric the platform refused is null, never zero: those rows leave the sample.
  const armsFor = (metric: MetricName) => {
    const arms = new Map<string, number[]>();
    for (const row of scoped) {
      const arm = armOf(row, options.feature);
      const value = metricValue(row, metric);
      if (arm === null || value === null) continue;
      arms.set(arm, [...(arms.get(arm) ?? []), value]);
    }
    return arms;
  };
  const metrics = metricOrder[options.platform];
  const metric =
    metrics.find((name) => armsFor(name).size >= 2) ??
    metrics.find((name) => armsFor(name).size >= 1) ??
    null;
  if (!metric) return [];
  const arms = armsFor(metric);
  const ranked = [...arms.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  const base = ranked[0];
  if (!base) return [];
  return ranked.slice(1).map(([armB, valuesB]) => {
    const [armA, valuesA] = base;
    const nA = valuesA.length;
    const nB = valuesB.length;
    const meanA = mean(valuesA);
    const meanB = mean(valuesB);
    const pooled = Math.sqrt(
      ((nA - 1) * variance(valuesA) + (nB - 1) * variance(valuesB)) / Math.max(1, nA + nB - 2),
    );
    const delta = meanB - meanA;
    const enough = nA >= MIN_ARM_OBSERVATIONS && nB >= MIN_ARM_OBSERVATIONS;
    const learned = enough && Math.abs(delta) > pooled;
    return {
      feature: options.feature,
      armA,
      armB,
      metric,
      platform: options.platform,
      checkpoint: `${options.checkpointDays}d`,
      nA,
      nB,
      deltaPct: meanA === 0 ? null : Math.round((delta / meanA) * 100),
      ...(learned ? { winner: delta > 0 ? armB : armA } : {}),
      status: learned ? ("learning" as const) : ("insufficient_data" as const),
      confidence: "directional" as const,
    };
  });
};

const platforms: readonly Platform[] = ["instagram", "youtube", "tiktok", "threads"];
/** Every feature (or the one asked for) on every platform (or the one asked for). */
export const computeAllLearnings = (
  rows: readonly CheckpointObservation[],
  options: Readonly<{
    checkpointDays: CheckpointDays;
    feature?: LearningFeature;
    platform?: Platform;
  }>,
): readonly Learning[] =>
  (options.feature ? [options.feature] : learningFeatures).flatMap((feature) =>
    (options.platform ? [options.platform] : platforms).flatMap((platform) =>
      computeLearnings(rows, { feature, platform, checkpointDays: options.checkpointDays }),
    ),
  );
