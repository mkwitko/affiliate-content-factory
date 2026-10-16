import type { ResearchSnapshot } from "./research-snapshot.js";

export type NicheResearchContext = Readonly<{
  keywords: readonly string[];
  pains: readonly string[];
  referenceProducts: readonly string[];
  exclusions: readonly string[];
}>;

type Bucket = keyof NicheResearchContext;

const categoryByKey: Readonly<Record<string, Bucket>> = {
  keyword: "keywords",
  pain: "pains",
  reference_product: "referenceProducts",
  exclusion: "exclusions",
};

export const buildNicheResearchContext = (
  snapshots: readonly ResearchSnapshot[],
): NicheResearchContext => {
  const buckets: Record<Bucket, string[]> = {
    keywords: [],
    pains: [],
    referenceProducts: [],
    exclusions: [],
  };
  for (const snapshot of snapshots) {
    for (const observation of snapshot.observations) {
      const bucket = categoryByKey[observation.key.toLowerCase()];
      if (!bucket) continue;
      if (!buckets[bucket].includes(observation.value)) buckets[bucket].push(observation.value);
    }
  }
  return Object.freeze({
    keywords: Object.freeze(buckets.keywords),
    pains: Object.freeze(buckets.pains),
    referenceProducts: Object.freeze(buckets.referenceProducts),
    exclusions: Object.freeze(buckets.exclusions),
  });
};
