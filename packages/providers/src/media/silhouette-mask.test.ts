import { describe, expect, it } from "vitest";
import { readExplainerContext } from "@money-maker/core/explainer/explainer-context";
import { BIBLE_CAST } from "@money-maker/core/explainer/fixtures/cast/bible-cast";
import { SILHOUETTE_IOU_MAX, silhouetteReport } from "@money-maker/core/explainer/silhouette";
import { castSilhouettes } from "./silhouette-mask.js";

// The fixture goes through the niche reader, so it is exactly what a stored cast renders.
const cast =
  readExplainerContext({ kind: "media", context: { characters: BIBLE_CAST } })?.characters ?? [];

describe("silhouette test on the fixture cast of six", () => {
  it("reads all six bibles", () => {
    expect(cast.map((c) => c.bible?.body.archetype)).toEqual([
      "average",
      "lanky",
      "heavy",
      "tall_strong",
      "elder",
      "tiny",
    ]);
  });

  it("keeps every pair under the IoU threshold with at least two distinct traits", async () => {
    const report = silhouetteReport(cast, await castSilhouettes(cast));
    expect(report.pairs).toHaveLength(15);
    expect(report.warnings).toEqual([]);
    expect(Math.max(...report.pairs.map((p) => p.iou))).toBeLessThanOrEqual(SILHOUETTE_IOU_MAX);
  });

  it("flags the same cast drawn without bibles (the test discriminates)", async () => {
    const plain = cast.map(({ key, name, role, rigId, rigVersion, palette }) => ({
      key,
      name,
      role,
      rigId,
      rigVersion,
      palette,
    }));
    const report = silhouetteReport(plain, await castSilhouettes(plain));
    expect(report.warnings.some((w) => w.startsWith("silhouette_iou:"))).toBe(true);
    expect(report.warnings.some((w) => w.startsWith("silhouette_not_distinct:"))).toBe(true);
  });
});
