const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PATTERN_SAMPLES = 10;
const enumValues = {
  hookMove: ["curiosity_gap", "bold_claim", "contrast", "proof_first"],
  proofType: ["rating", "sold_count", "discount", "buyer_quote", "spec", "none"],
  urgency: ["none", "durable", "scarcity"],
} as const;
const booleanFeatures = ["priceShown", "discountShown", "ratingShown"] as const;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type CreativePatternPost = Readonly<{
  channelId: string;
  publishedAt: Date | null;
  observedAt: Date;
  creativeFeatures: unknown;
  clicks: number;
  uniqueClicks: number;
  clickRate: number | null;
}>;

export type CreativePatternSummary = Readonly<{
  channelId: string;
  metricAgeDays: number;
  feature: string;
  value: string | boolean;
  sampleCount: number;
  sufficiency: "sufficient_sample_count" | "insufficient_data";
  clicks: number;
  uniqueClicks: number;
  clickRateSamples: number;
  averageClickRate: number | null;
}>;

const featureEntries = (features: unknown): readonly (readonly [string, string | boolean])[] => {
  if (!isRecord(features)) return [];
  const entries: [string, string | boolean][] = [];
  for (const [feature, values] of Object.entries(enumValues)) {
    const value = features[feature];
    if (typeof value === "string" && (values as readonly string[]).includes(value))
      entries.push([feature, value]);
  }
  const angle = features.angle;
  if (typeof angle === "string" && angle.trim()) entries.push(["angle", angle.trim()]);
  for (const feature of booleanFeatures) {
    const value = features[feature];
    if (typeof value === "boolean") entries.push([feature, value]);
  }
  return entries;
};

export const summarizeCreativePatterns = (
  posts: readonly CreativePatternPost[],
): readonly CreativePatternSummary[] => {
  const groups = new Map<
    string,
    {
      channelId: string;
      metricAgeDays: number;
      feature: string;
      value: string | boolean;
      clicks: number;
      uniqueClicks: number;
      rates: number[];
      sampleCount: number;
    }
  >();

  for (const post of posts) {
    if (
      !post.publishedAt ||
      !Number.isFinite(post.publishedAt.getTime()) ||
      !Number.isFinite(post.observedAt.getTime()) ||
      post.observedAt < post.publishedAt
    )
      continue;
    const metricAgeDays = Math.floor(
      (post.observedAt.getTime() - post.publishedAt.getTime()) / DAY_MS,
    );
    for (const [feature, value] of featureEntries(post.creativeFeatures)) {
      const groupKey = JSON.stringify([post.channelId, metricAgeDays, feature, value]);
      const group = groups.get(groupKey) ?? {
        channelId: post.channelId,
        metricAgeDays,
        feature,
        value,
        clicks: 0,
        uniqueClicks: 0,
        rates: [],
        sampleCount: 0,
      };
      group.sampleCount += 1;
      group.clicks += post.clicks;
      group.uniqueClicks += post.uniqueClicks;
      if (post.clickRate !== null && Number.isFinite(post.clickRate))
        group.rates.push(post.clickRate);
      groups.set(groupKey, group);
    }
  }

  return [...groups.values()]
    .sort((a, b) =>
      `${a.channelId}\u0000${a.metricAgeDays}\u0000${a.feature}\u0000${a.value}`.localeCompare(
        `${b.channelId}\u0000${b.metricAgeDays}\u0000${b.feature}\u0000${b.value}`,
      ),
    )
    .map((group) => ({
      channelId: group.channelId,
      metricAgeDays: group.metricAgeDays,
      feature: group.feature,
      value: group.value,
      sampleCount: group.sampleCount,
      sufficiency:
        group.sampleCount >= MIN_PATTERN_SAMPLES ? "sufficient_sample_count" : "insufficient_data",
      clicks: group.clicks,
      uniqueClicks: group.uniqueClicks,
      clickRateSamples: group.rates.length,
      averageClickRate: group.rates.length
        ? Math.round(
            (group.rates.reduce((sum, rate) => sum + rate, 0) / group.rates.length) * 10_000,
          ) / 10_000
        : null,
    }));
};
