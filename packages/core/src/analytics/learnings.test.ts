import { describe, expect, it } from "vitest";
import { computeLearnings, type CheckpointObservation } from "./learnings.js";

const row = (
  arm: string,
  shares: number | undefined,
  extra: Partial<CheckpointObservation> = {},
): CheckpointObservation => ({
  contentVariantId: `v-${Math.random()}`,
  channelId: "c",
  channelKind: "instagram_reels",
  publishedAt: new Date("2026-09-20T15:00:00Z"),
  observedAt: new Date("2026-09-27T15:00:00Z"),
  metrics: shares === undefined ? {} : { shares },
  creativeFeatures: { hookMove: arm },
  uniqueClicks: 0,
  ...extra,
});
const many = (arm: string, values: number[]) => values.map((value) => row(arm, value));
const opts = { feature: "hookMove", platform: "instagram", checkpointDays: 7 } as const;

describe("computeLearnings", () => {
  it("emits a learning for a clear win with 9 vs 11 observations", () => {
    const a = many("contrast", [10, 11, 12, 10, 11, 12, 11, 10, 12, 11, 10]);
    const b = many("bold_claim", [20, 21, 22, 20, 21, 22, 21, 20, 22]);
    const [learning] = computeLearnings([...a, ...b], opts);
    expect(learning).toMatchObject({
      feature: "hookMove",
      armA: "contrast",
      armB: "bold_claim",
      metric: "shares",
      platform: "instagram",
      checkpoint: "7d",
      nA: 11,
      nB: 9,
      status: "learning",
      winner: "bold_claim",
      confidence: "directional",
    });
    expect(learning?.deltaPct).toBeGreaterThan(50);
  });
  it("says insufficient_data with counts below 8 per arm", () => {
    const a = many("contrast", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const b = many("bold_claim", [50, 51, 52, 53, 54, 55, 56]);
    const [learning] = computeLearnings([...a, ...b], opts);
    expect(learning).toMatchObject({ status: "insufficient_data", nA: 11, nB: 7 });
    expect(learning?.winner).toBeUndefined();
  });
  it("needs the delta to exceed the pooled standard deviation", () => {
    const a = many("contrast", [0, 10, 0, 10, 0, 10, 0, 10]);
    const b = many("bold_claim", [1, 11, 1, 11, 1, 11, 1, 11]);
    expect(computeLearnings([...a, ...b], opts)[0]?.status).toBe("insufficient_data");
  });
  it("excludes refused (empty) metrics instead of counting them as zero", () => {
    const a = [
      ...many("contrast", [10, 11, 12, 10, 11, 12, 11, 10]),
      ...Array.from({ length: 5 }, () => row("contrast", undefined)),
    ];
    const b = many("bold_claim", [30, 31, 32, 30, 31, 32, 31, 30]);
    const [learning] = computeLearnings([...a, ...b], opts);
    expect(learning).toMatchObject({ nA: 8, nB: 8, status: "learning" });
  });
  it("ignores other platforms and rows without the feature", () => {
    const other = many("contrast", [1, 2, 3]).map((r) => ({
      ...r,
      channelKind: "youtube" as const,
    }));
    const bare = [row("x", 5, { creativeFeatures: null })];
    expect(computeLearnings([...other, ...bare], opts)).toEqual([]);
  });
  it("falls back to click rate when a platform has no shares", () => {
    const click = (arm: string, unique: number) =>
      row(arm, undefined, { metrics: { reach: 100 }, uniqueClicks: unique });
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => click("contrast", 1 + (i % 2))),
      ...Array.from({ length: 8 }, (_, i) => click("bold_claim", 10 + (i % 2))),
    ];
    expect(computeLearnings(rows, opts)[0]).toMatchObject({
      metric: "clickRate",
      status: "learning",
    });
  });
  it("excludes click rate for posts without a tracked link instead of counting zero", () => {
    const untracked = (arm: string) =>
      row(arm, undefined, { metrics: { reach: 100 }, uniqueClicks: null });
    const rows = [
      ...Array.from({ length: 8 }, () => untracked("contrast")),
      ...Array.from({ length: 8 }, () => untracked("bold_claim")),
    ];
    expect(computeLearnings(rows, opts).filter((entry) => entry.metric === "clickRate")).toEqual(
      [],
    );
  });
  it("groups a numeric feature into duration bands", () => {
    const rows = [
      ...Array.from({ length: 8 }, (_, i) =>
        row("a", 10 + i, { creativeFeatures: { durationSec: 20 } }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        row("a", 40 + i, { creativeFeatures: { durationSec: 70 } }),
      ),
    ];
    const [learning] = computeLearnings(rows, { ...opts, feature: "durationBand" });
    expect(new Set([learning?.armA, learning?.armB])).toEqual(new Set(["15-30s", "60-180s"]));
  });
});
