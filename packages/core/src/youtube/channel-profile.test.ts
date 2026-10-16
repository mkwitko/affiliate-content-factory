import { describe, expect, it } from "vitest";
import { readPackagingProfile } from "./channel-profile.js";

const niche = (context: Record<string, unknown> | null) => ({ kind: "media" as const, context });

describe("readPackagingProfile", () => {
  it("is null without packaging, or for a non-media niche", () => {
    expect(readPackagingProfile(niche({}))).toBeNull();
    expect(readPackagingProfile(niche(null))).toBeNull();
    expect(
      readPackagingProfile({ kind: "affiliate", context: { packaging: { maxOverlayWords: 3 } } }),
    ).toBeNull();
  });
  it("applies defaults for an empty packaging block", () => {
    expect(readPackagingProfile(niche({ packaging: {} }))).toEqual({
      maxOverlayWords: 4,
      titlePatterns: [],
      hookPatterns: [],
      thumbnailRules: [],
      forbiddenPhrases: [],
    });
  });
  it("reads patterns, rules, forbidden phrases, tagline and cadence", () => {
    const profile = readPackagingProfile(
      niche({
        tagline: "Why things cost what they cost.",
        forbiddenPhrases: ["game changer"],
        cadence: { longFormPerWeek: 3, shortsPerLongForm: 3 },
        packaging: {
          maxOverlayWords: 3,
          titlePatterns: [{ id: "CC1", label: "WHY_BEHAVIOR", example: "Why X" }],
          hookPatterns: [{ id: "HK1", label: "RESTATE_AND_RAISE" }],
          thumbnailRules: ["One focal point"],
        },
      }),
    );
    expect(profile).toEqual({
      tagline: "Why things cost what they cost.",
      cadence: { longFormPerWeek: 3, shortsPerLongForm: 3 },
      forbiddenPhrases: ["game changer"],
      maxOverlayWords: 3,
      titlePatterns: [{ id: "CC1", label: "WHY_BEHAVIOR", example: "Why X" }],
      hookPatterns: [{ id: "HK1", label: "RESTATE_AND_RAISE" }],
      thumbnailRules: ["One focal point"],
    });
  });
  it("ignores malformed entries", () => {
    const profile = readPackagingProfile(
      niche({
        forbiddenPhrases: ["ok", 3, ""],
        cadence: { longFormPerWeek: 0, shortsPerLongForm: 2 },
        packaging: {
          maxOverlayWords: 99,
          titlePatterns: [{ id: "bad", label: "X" }, { id: "CC2", label: "HIDDEN_COST" }, 7],
          hookPatterns: "nope",
          thumbnailRules: ["fine", 4],
        },
      }),
    );
    expect(profile?.forbiddenPhrases).toEqual(["ok"]);
    expect(profile?.cadence).toBeUndefined();
    expect(profile?.maxOverlayWords).toBe(4);
    expect(profile?.titlePatterns).toEqual([{ id: "CC2", label: "HIDDEN_COST" }]);
    expect(profile?.hookPatterns).toEqual([]);
    expect(profile?.thumbnailRules).toEqual(["fine"]);
  });
});
