import { visualLanguageProfileSchema } from "@money-maker/contracts/visual-language-schema";
import { describe, expect, it } from "vitest";
import { GOUACHE_V1 } from "./fixtures/visual-language/gouache-v1.js";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
  readExplainerContext,
} from "./explainer-context.js";
import { composeMotionFrame } from "./motion/frame.js";
import { type MotionSceneTiming, planMotion } from "./motion/plan.js";
import { GRAMMAR } from "./motion/tuning.js";
import type { SceneSpec } from "./scene-spec.js";
import {
  contrastRatio,
  FLAT_VECTOR_PROFILE,
  grammarFromProfile,
  lintVisualLanguageProfile,
  readVisualLanguageProfile,
} from "./visual-language.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const timing: MotionSceneTiming = {
  startMs: 0,
  endMs: 3_000,
  voiceStartMs: 200,
  voiceEndMs: 2_600,
  text: "why is milk at the back",
  words: ["why", "is", "milk", "at", "the", "back"].map((text, i) => ({
    text,
    startMs: 200 + i * 400,
    endMs: 550 + i * 400,
  })),
};
const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 23,
  purpose: "hook",
  background: "store",
  actors: [
    {
      characterKey: "alex",
      pose: "pointing",
      expression: "happy",
      position: "left",
      actions: [{ type: "point_at", atWord: 2, target: { kind: "prop", index: 0 } }],
    },
  ],
  props: [{ type: "milk_carton", position: "right" }],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
};
const frame = (extra: Partial<Parameters<typeof planMotion>[0]>, t = 1_300) =>
  composeMotionFrame(
    planMotion({
      scenes: [scene],
      timings: [timing],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 3_000,
      ...extra,
    }),
    t,
  );

describe("FLAT_VECTOR_PROFILE", () => {
  it("draws byte-identical frames, grammar off or on", () => {
    for (const t of [300, 1_300, 2_000]) {
      expect(frame({ visualLanguage: FLAT_VECTOR_PROFILE }, t)).toBe(frame({}, t));
      expect(frame({ visualLanguage: FLAT_VECTOR_PROFILE, motionGrammar: true }, t)).toBe(
        frame({ motionGrammar: true }, t),
      );
    }
  });

  it("passes its own lint and gives back GRAMMAR", () => {
    expect(lintVisualLanguageProfile(FLAT_VECTOR_PROFILE)).toEqual([]);
    expect(grammarFromProfile(FLAT_VECTOR_PROFILE)).toEqual(GRAMMAR);
  });
});

describe("a measured profile", () => {
  const profile = readVisualLanguageProfile({
    id: "cutout-v1",
    version: 1,
    palette: { roles: { accent: "#2A9D8F", textPlate: "#101820" } },
    type: { captionPx: [52, 58] },
    motion: { overshootPct: [20, 24] },
  });

  it("resolves partial values against the defaults", () => {
    expect(profile?.palette.roles.accent).toBe("#2A9D8F");
    expect(profile?.palette.roles.textOn).toBe("#ffffff");
    expect(profile?.type.captionPx).toEqual([52, 58]);
    expect(grammarFromProfile(profile ?? FLAT_VECTOR_PROFILE).overshoot).toBeCloseTo(0.22);
    expect(readVisualLanguageProfile({ version: 1 })).toBeNull();
    expect(readVisualLanguageProfile(undefined)).toBeNull();
  });

  it("drives the caption accent, plate and size", () => {
    const svg = frame({ visualLanguage: profile ?? undefined });
    expect(svg).toContain('fill="#2A9D8F"');
    expect(svg).toContain('fill="#101820" fill-opacity="0.88"');
    expect(svg).toMatch(/font-size="(5[0-8])" xml:space="preserve"/);
  });

  it("is read from the niche context and accepted at the MCP boundary", () => {
    const stored = { id: "cutout-v1", version: 1, type: { captionPx: [52, 58] } };
    expect(visualLanguageProfileSchema.safeParse(stored).success).toBe(true);
    expect(visualLanguageProfileSchema.safeParse({ ...stored, extra: 1 }).success).toBe(false);
    const context = readExplainerContext({
      kind: "media",
      context: { explainer: { visualLanguage: stored } },
    });
    expect(context?.visualLanguage?.id).toBe("cutout-v1");
  });
});

describe("lintVisualLanguageProfile", () => {
  it.each([
    [
      "caption_contrast",
      { palette: { roles: { textOn: "#777777", textPlate: "#666666" } } },
      "block",
    ],
    ["hero_outside_safe_box", { composition: { heroYRange: [0.05, 0.9] } }, "block"],
    ["hero_x_outside_safe_box", { composition: { heroXFractions: [0.02, 0.5] } }, "block"],
    ["caption_too_small", { type: { captionPx: [30, 40] } }, "warn"],
    ["value_tiers_not_one", { value: { areaTarget: [0.5, 0.5, 0.5] } }, "warn"],
  ] as const)("%s", (id, override, severity) => {
    const profile = readVisualLanguageProfile({ id: "x", version: 1, ...override });
    expect(lintVisualLanguageProfile(profile ?? FLAT_VECTOR_PROFILE)).toContainEqual(
      expect.objectContaining({ id, severity }),
    );
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBe(21);
    expect(contrastRatio("#ffffff", "#161616")).toBeGreaterThan(17);
  });
});

describe("the chosen look (gouache-v1)", () => {
  it("is valid at the boundary, lint-clean and changes no pixel when applied", () => {
    expect(visualLanguageProfileSchema.safeParse(GOUACHE_V1).success).toBe(true);
    const profile = readVisualLanguageProfile(GOUACHE_V1);
    expect(profile).toMatchObject({
      characterStyle: "EXPRESSIVE_INK",
      environmentStyle: "GOUACHE_PAINTED",
    });
    expect(lintVisualLanguageProfile(profile ?? FLAT_VECTOR_PROFILE)).toEqual([]);
    for (const t of [300, 1_300, 2_000])
      expect(frame({ visualLanguage: profile ?? undefined }, t)).toBe(frame({}, t));
  });
});
