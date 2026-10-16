import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { PackagingProfile } from "./channel-profile.js";
import {
  contentWords,
  EpisodeIdeaError,
  SCORE_MAX,
  archiveIdea,
  checkPackagingVariant,
  checkVariantSet,
  createEpisodeIdea,
  decideIdea,
  recordPackaging,
  scoreIdea,
  startProduction,
  type HookContract,
  type PackagingVariant,
  type ScoreDimension,
} from "./episode-idea.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const profile: PackagingProfile = {
  forbiddenPhrases: [],
  maxOverlayWords: 4,
  titlePatterns: [
    { id: "CC1", label: "WHY_BEHAVIOR" },
    { id: "CC5", label: "PRICE_PSYCHOLOGY" },
  ],
  hookPatterns: [{ id: "HK1", label: "RESTATE_AND_RAISE" }],
  thumbnailRules: [],
};
const full = Object.fromEntries(Object.entries(SCORE_MAX).map(([k, v]) => [k, v])) as Record<
  ScoreDimension,
  number
>;
const scoreInput = (dimensions: Record<ScoreDimension, number> = full) => ({
  dimensions,
  rationale: "r",
  confidence: "medium" as const,
  evidence: [{ statement: "s", evidenceType: "OUR_HYPOTHESIS" as const }],
});
const variant = (id: "A" | "B" | "C", over: Partial<PackagingVariant> = {}): PackagingVariant => ({
  id,
  title: "Why Supermarkets Put Milk in the Back",
  titlePattern: "CC1",
  thumbnail: {
    angle: "a",
    focalSubject: "milk",
    overlayText: "THE LONG WALK",
    composition: "c",
    background: "b",
    contrastStrategy: "s",
    titleThumbnailSplit: "t",
    hypothesis: "h",
  },
  hookPattern: "HK1",
  openingHook: "o",
  audiencePromise: "p",
  hypothesis: "h",
  ...over,
});
const contract: HookContract = {
  packagingPromise: "p",
  firstVisual: "v",
  proofOrTensionBySecond: 8,
  firstOpenLoop: "l",
  firstOpenLoopBySecond: 10,
  firstPartialPayoffBySecond: 25,
  prohibitedIntroElements: ["channel intro"],
};
const idea = () =>
  createEpisodeIdea({
    id: "i1",
    workspaceId,
    nicheId: "n1",
    workingTitle: "Milk",
    score: scoreIdea(scoreInput()),
    now: new Date(0),
  });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof EpisodeIdeaError ? e.code : "other";
  }
  return "none";
};

describe("scoreIdea", () => {
  it("sums the dimensions to 100 and computes the total itself", () => {
    expect(Object.values(SCORE_MAX).reduce((a, b) => a + b, 0)).toBe(100);
    expect(scoreIdea(scoreInput()).total).toBe(100);
    expect(scoreIdea(scoreInput({ ...full, browse: 7 })).total).toBe(92);
  });
  it("rejects out-of-range and missing dimensions", () => {
    expect(code(() => scoreIdea(scoreInput({ ...full, browse: 16 })))).toBe("score_out_of_range");
    expect(code(() => scoreIdea(scoreInput({ ...full, title: -1 })))).toBe("score_out_of_range");
    const { hook: _hook, ...rest } = full;
    expect(code(() => scoreIdea(scoreInput(rest as Record<ScoreDimension, number>)))).toBe(
      "score_dimension_missing",
    );
  });
});

describe("checkPackagingVariant", () => {
  it("passes complementary overlay text", () => {
    const checks = checkPackagingVariant(variant("A"), profile);
    expect(checks).toMatchObject({
      duplicateMessage: false,
      complementary: true,
      overlayWordCount: 3,
    });
    expect(checks.notes).toEqual([]);
  });
  it("flags an overlay that repeats the title", () => {
    const checks = checkPackagingVariant(
      variant("A", { thumbnail: { ...variant("A").thumbnail, overlayText: "milk in the back" } }),
      profile,
    );
    expect(checks.duplicateMessage).toBe(true);
    expect(checks.complementary).toBe(false);
  });
  it("flags high overlap even when the overlay adds a word", () => {
    const checks = checkPackagingVariant(
      variant("A", {
        title: "Supermarkets milk back",
        thumbnail: { ...variant("A").thumbnail, overlayText: "Supermarkets milk back wait" },
      }),
      profile,
    );
    expect(checks.semanticOverlap).toBeGreaterThanOrEqual(0.6);
    expect(checks.duplicateMessage).toBe(true);
  });
  it("notes an overlay longer than the profile allows", () => {
    const checks = checkPackagingVariant(
      variant("A", {
        thumbnail: { ...variant("A").thumbnail, overlayText: "one two three four five" },
      }),
      profile,
    );
    expect(checks.overlayWordCount).toBe(5);
    expect(checks.notes.join(" ")).toContain("overlay");
  });
  it("accepts a variant without overlay text", () => {
    const { overlayText: _o, ...thumbnail } = variant("A").thumbnail;
    expect(checkPackagingVariant(variant("A", { thumbnail }), profile).overlayWordCount).toBe(0);
  });
  it("errors on a pattern outside the profile", () => {
    expect(code(() => checkPackagingVariant(variant("A", { titlePattern: "CC9" }), profile))).toBe(
      "unknown_title_pattern",
    );
    expect(code(() => checkPackagingVariant(variant("A", { hookPattern: "HK9" }), profile))).toBe(
      "unknown_hook_pattern",
    );
  });
});

describe("checkVariantSet", () => {
  it("needs 2 or 3 variants with distinct ids", () => {
    expect(code(() => checkVariantSet([variant("A")]))).toBe("variant_count");
    expect(code(() => checkVariantSet([variant("A"), variant("A")]))).toBe("variant_ids");
  });
  it("notes near-identical titles", () => {
    expect(checkVariantSet([variant("A"), variant("B")]).join(" ")).toContain("near-identical");
    expect(
      checkVariantSet([variant("A"), variant("B", { title: "Why Everything Costs $9.99" })]),
    ).toEqual([]);
  });
});

describe("transitions", () => {
  const variants = [variant("A"), variant("B", { title: "Why Everything Costs $9.99" })];
  const packaged = () => recordPackaging(idea(), variants, profile, new Date(1));
  it("records packaging from idea or packaging", () => {
    const first = packaged();
    expect(first.status).toBe("packaging");
    expect(first.packagingChecks).toHaveLength(2);
    expect(recordPackaging(first, variants, profile, new Date(2)).status).toBe("packaging");
  });
  it("approves a packaged idea with a valid variant and contract", () => {
    const approved = decideIdea(
      packaged(),
      { decision: "approve", variantId: "A", hookContract: contract },
      new Date(2),
    );
    expect(approved).toMatchObject({ status: "approved", selectedVariantId: "A" });
  });
  it("refuses to approve without packaging, a known variant, or a valid contract", () => {
    const approve = { decision: "approve" as const, variantId: "A", hookContract: contract };
    expect(code(() => decideIdea(idea(), approve, new Date()))).toBe("invalid_transition");
    expect(code(() => decideIdea(packaged(), { ...approve, variantId: "C" }, new Date()))).toBe(
      "unknown_variant",
    );
    const { hookContract: _h, ...noContract } = approve;
    expect(code(() => decideIdea(packaged(), noContract, new Date()))).toBe(
      "hook_contract_missing",
    );
    expect(
      code(() =>
        decideIdea(
          packaged(),
          { ...approve, hookContract: { ...contract, proofOrTensionBySecond: 0 } },
          new Date(),
        ),
      ),
    ).toBe("hook_contract_invalid");
    expect(
      code(() =>
        decideIdea(
          packaged(),
          { ...approve, hookContract: { ...contract, firstOpenLoopBySecond: 30 } },
          new Date(),
        ),
      ),
    ).toBe("hook_contract_invalid");
  });
  it("refuses a variant whose overlay repeats the title", () => {
    const dup = variant("A", {
      thumbnail: { ...variant("A").thumbnail, overlayText: "milk back" },
    });
    const p = recordPackaging(idea(), [dup, variants[1] as PackagingVariant], profile, new Date());
    expect(
      code(() =>
        decideIdea(p, { decision: "approve", variantId: "A", hookContract: contract }, new Date()),
      ),
    ).toBe("duplicate_message");
  });
  it("revise keeps packaging and stores the note; reject is final", () => {
    const revised = decideIdea(packaged(), { decision: "revise", note: "shorter" }, new Date(3));
    expect(revised).toMatchObject({ status: "packaging", decisionNote: "shorter" });
    const rejected = decideIdea(revised, { decision: "reject", note: "no" }, new Date(4));
    expect(rejected.status).toBe("rejected");
    expect(code(() => decideIdea(rejected, { decision: "reject" }, new Date()))).toBe(
      "invalid_transition",
    );
    expect(code(() => decideIdea(idea(), { decision: "revise" }, new Date()))).toBe(
      "invalid_transition",
    );
  });
  it("starts production only from approved, and archives from anywhere", () => {
    expect(code(() => startProduction(packaged(), "c1", new Date()))).toBe("invalid_transition");
    const approved = decideIdea(
      packaged(),
      { decision: "approve", variantId: "A", hookContract: contract },
      new Date(),
    );
    const live = startProduction(approved, "c1", new Date());
    expect(live).toMatchObject({ status: "in_production", contentItemId: "c1" });
    expect(archiveIdea(live, new Date()).status).toBe("archived");
    expect(archiveIdea(idea(), new Date()).status).toBe("archived");
  });
});

describe("contentWords", () => {
  it("drops sentence punctuation but keeps prices and contractions whole", () => {
    expect([...contentWords("Not really free. It costs $9.99. Don't pay.")]).toEqual([
      "not",
      "really",
      "free",
      "costs",
      "$9.99",
      "don't",
      "pay",
    ]);
  });
});
