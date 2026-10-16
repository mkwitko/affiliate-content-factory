import {
  type CompositingProfile,
  DEFAULT_COMPOSITING,
  readCompositingProfile,
} from "./compositing.js";
import { FRAME, SAFE_BOX } from "./layout.js";
import { GRAMMAR } from "./motion/tuning.js";

/**
 * VisualLanguageProfile (Stickman v2 spec section 10.2, slice 18): the measured look of a show,
 * one per niche, versioned. Its values come from the accepted style frames
 * (`measure-style-frames`), never from guesses; until the owner accepts a look, only the
 * FLAT_VECTOR defaults below exist, and they reproduce today's frames exactly.
 */
export type CharacterStyle = "EXPRESSIVE_INK" | "EDITORIAL_FLAT" | "CINEMATIC_GRAPHIC";
export type EnvironmentStyle =
  | "FLAT_VECTOR"
  | "CUTOUT_PAINTED"
  | "GOUACHE_PAINTED"
  | "DARK_GRAPHIC";
export const PALETTE_ROLES = [
  "bgFar",
  "bgMid",
  "ink",
  "hero",
  "foe",
  "accent",
  "light",
  "shadow",
  "textOn",
  "textPlate",
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export const COLOUR_STATES = ["hook", "problem", "explain", "twist", "resolve"] as const;
export type ColourState = (typeof COLOUR_STATES)[number];
type Pair = readonly [number, number];

export type VisualLanguageProfile = Readonly<{
  id: string;
  version: number;
  characterStyle: CharacterStyle;
  environmentStyle: EnvironmentStyle;
  line: Readonly<{ strokePx: number; wobblePct: number; outline: boolean }>;
  palette: Readonly<{
    roles: Readonly<Record<PaletteRole, string>>;
    areaMax: Readonly<{ dominant: number; secondary: number; accent: number }>;
    chromaCap: Readonly<{ bg: number; character: number }>;
  }>;
  value: Readonly<{ areaTarget: readonly [number, number, number]; minFocalDeltaL: number }>;
  type: Readonly<{ captionPx: Pair; numberPx: Pair; maxWordsChunk: number; minContrast: number }>;
  composition: Readonly<{ heroXFractions: readonly number[]; heroYRange: Pair; heroAreaPct: Pair }>;
  motion: Readonly<{
    durationClassesFrames: readonly number[];
    anticipationPct: Pair;
    overshootPct: Pair;
    settleFrames: Pair;
    maxStaticFrames: number;
  }>;
  colorScript: Readonly<
    Record<ColourState, Readonly<{ satDelta: number; valDelta: number; hueDeg: number }>>
  >;
  pacing: Readonly<{ changeEverySec: Pair; maxGapSec: number }>;
  compositing: CompositingProfile;
}>;

const neutralState = Object.freeze({ satDelta: 0, valDelta: 0, hueDeg: 0 });
/** DEFAULT_SCENE_PALETTE's values, inlined: explainer-context imports this module. */
const SCENE = Object.freeze({
  surface: "#F6F1E7",
  muted: "#D9D2C5",
  accent: "#FF5A36",
  text: "#161616",
  line: "#161616",
});

/**
 * Today's look as a profile (the permanent fallback, spec 10.1): rig line 14 px, the scene
 * palette, captions fitted up to 64 px, the motion grammar's HYPOTHESIS numbers and the default
 * compositing. Applying it changes no pixel (tested); areas and targets are recorded, not enforced.
 */
export const FLAT_VECTOR_PROFILE: VisualLanguageProfile = Object.freeze({
  id: "flat-vector-default",
  version: 1,
  characterStyle: "EDITORIAL_FLAT",
  environmentStyle: "FLAT_VECTOR",
  line: Object.freeze({ strokePx: 14, wobblePct: 0, outline: true }),
  palette: Object.freeze({
    roles: Object.freeze({
      bgFar: SCENE.surface,
      bgMid: SCENE.muted,
      ink: SCENE.line,
      hero: "#FFFFFF",
      foe: SCENE.text,
      accent: SCENE.accent,
      light: "#FFFFFF",
      shadow: "#000000",
      textOn: "#ffffff",
      textPlate: SCENE.line,
    }),
    areaMax: Object.freeze({ dominant: 0.7, secondary: 0.25, accent: 0.1 }),
    chromaCap: Object.freeze({ bg: 0.6, character: 1 }),
  }),
  value: Object.freeze({
    areaTarget: Object.freeze([0.15, 0.25, 0.6] as const),
    minFocalDeltaL: DEFAULT_COMPOSITING.focalContrastTarget,
  }),
  type: Object.freeze({
    captionPx: Object.freeze([48, 64] as const),
    numberPx: Object.freeze([96, 140] as const),
    maxWordsChunk: 3,
    minContrast: 4.5,
  }),
  composition: Object.freeze({
    heroXFractions: Object.freeze([300 / FRAME.width, 540 / FRAME.width, 780 / FRAME.width]),
    heroYRange: Object.freeze([
      SAFE_BOX.top / FRAME.height,
      SAFE_BOX.bottom / FRAME.height,
    ] as const),
    heroAreaPct: Object.freeze([4, 25] as const),
  }),
  motion: Object.freeze({
    durationClassesFrames: GRAMMAR.durationClassesFrames,
    anticipationPct: Object.freeze([
      GRAMMAR.anticipationShare * 100,
      GRAMMAR.anticipationShare * 100,
    ] as const),
    overshootPct: Object.freeze([GRAMMAR.overshoot * 100, GRAMMAR.overshoot * 100] as const),
    settleFrames: Object.freeze([6, 12] as const),
    maxStaticFrames: Math.round((GRAMMAR.deadFrameMs * 30) / 1000),
  }),
  colorScript: Object.freeze({
    hook: neutralState,
    problem: neutralState,
    explain: neutralState,
    twist: neutralState,
    resolve: neutralState,
  }),
  pacing: Object.freeze({ changeEverySec: Object.freeze([2, 4] as const), maxGapSec: 4 }),
  compositing: DEFAULT_COMPOSITING,
});

// ---------------------------------------------------------------- reading

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
const num = (value: unknown, fallback: number, min = -1e9, max = 1e9): number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
const pair = (value: unknown, fallback: Pair, min = -1e9, max = 1e9): Pair => {
  if (!Array.isArray(value) || value.length !== 2) return fallback;
  const [a, b] = value;
  return typeof a === "number" && typeof b === "number" && a >= min && b <= max && a <= b
    ? Object.freeze([a, b] as const)
    : fallback;
};
const numbers = (value: unknown, fallback: readonly number[]): readonly number[] =>
  Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number" && v > 0)
    ? Object.freeze([...(value as number[])])
    : fallback;
const CHARACTER_STYLES: readonly string[] = [
  "EXPRESSIVE_INK",
  "EDITORIAL_FLAT",
  "CINEMATIC_GRAPHIC",
];
const ENVIRONMENT_STYLES: readonly string[] = [
  "FLAT_VECTOR",
  "CUTOUT_PAINTED",
  "GOUACHE_PAINTED",
  "DARK_GRAPHIC",
];

/**
 * A niche's stored profile (explainer.visualLanguage). Needs an id and a version; any other
 * field missing or out of range falls back to FLAT_VECTOR_PROFILE. Absent → null (today's path).
 */
export const readVisualLanguageProfile = (value: unknown): VisualLanguageProfile | null => {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.version !== "number")
    return null;
  const d = FLAT_VECTOR_PROFILE;
  const line = isRecord(value.line) ? value.line : {};
  const palette = isRecord(value.palette) ? value.palette : {};
  const roles = isRecord(palette.roles) ? palette.roles : {};
  const areaMax = isRecord(palette.areaMax) ? palette.areaMax : {};
  const chromaCap = isRecord(palette.chromaCap) ? palette.chromaCap : {};
  const val = isRecord(value.value) ? value.value : {};
  const type = isRecord(value.type) ? value.type : {};
  const composition = isRecord(value.composition) ? value.composition : {};
  const motion = isRecord(value.motion) ? value.motion : {};
  const colorScript = isRecord(value.colorScript) ? value.colorScript : {};
  const pacing = isRecord(value.pacing) ? value.pacing : {};
  const target = Array.isArray(val.areaTarget) && val.areaTarget.length === 3 ? val.areaTarget : [];
  return Object.freeze({
    id: value.id,
    version: Math.max(1, Math.floor(value.version)),
    characterStyle: CHARACTER_STYLES.includes(String(value.characterStyle))
      ? (value.characterStyle as CharacterStyle)
      : d.characterStyle,
    environmentStyle: ENVIRONMENT_STYLES.includes(String(value.environmentStyle))
      ? (value.environmentStyle as EnvironmentStyle)
      : d.environmentStyle,
    line: Object.freeze({
      strokePx: num(line.strokePx, d.line.strokePx, 1, 40),
      wobblePct: num(line.wobblePct, d.line.wobblePct, 0, 20),
      outline: typeof line.outline === "boolean" ? line.outline : d.line.outline,
    }),
    palette: Object.freeze({
      roles: Object.freeze(
        Object.fromEntries(
          PALETTE_ROLES.map((role) => [
            role,
            isHex(roles[role]) ? roles[role] : d.palette.roles[role],
          ]),
        ) as Record<PaletteRole, string>,
      ),
      areaMax: Object.freeze({
        dominant: num(areaMax.dominant, d.palette.areaMax.dominant, 0, 1),
        secondary: num(areaMax.secondary, d.palette.areaMax.secondary, 0, 1),
        accent: num(areaMax.accent, d.palette.areaMax.accent, 0, 1),
      }),
      chromaCap: Object.freeze({
        bg: num(chromaCap.bg, d.palette.chromaCap.bg, 0, 2),
        character: num(chromaCap.character, d.palette.chromaCap.character, 0, 2),
      }),
    }),
    value: Object.freeze({
      areaTarget: Object.freeze([
        num(target[0], d.value.areaTarget[0], 0, 1),
        num(target[1], d.value.areaTarget[1], 0, 1),
        num(target[2], d.value.areaTarget[2], 0, 1),
      ] as const),
      minFocalDeltaL: num(val.minFocalDeltaL, d.value.minFocalDeltaL, 0, 1),
    }),
    type: Object.freeze({
      captionPx: pair(type.captionPx, d.type.captionPx, 12, 200),
      numberPx: pair(type.numberPx, d.type.numberPx, 12, 400),
      maxWordsChunk: num(type.maxWordsChunk, d.type.maxWordsChunk, 1, 8),
      minContrast: num(type.minContrast, d.type.minContrast, 1, 21),
    }),
    composition: Object.freeze({
      heroXFractions: numbers(composition.heroXFractions, d.composition.heroXFractions),
      heroYRange: pair(composition.heroYRange, d.composition.heroYRange, 0, 1),
      heroAreaPct: pair(composition.heroAreaPct, d.composition.heroAreaPct, 0, 100),
    }),
    motion: Object.freeze({
      durationClassesFrames: numbers(motion.durationClassesFrames, d.motion.durationClassesFrames),
      anticipationPct: pair(motion.anticipationPct, d.motion.anticipationPct, 0, 60),
      overshootPct: pair(motion.overshootPct, d.motion.overshootPct, 0, 60),
      settleFrames: pair(motion.settleFrames, d.motion.settleFrames, 0, 120),
      maxStaticFrames: num(motion.maxStaticFrames, d.motion.maxStaticFrames, 1, 3_600),
    }),
    colorScript: Object.freeze(
      Object.fromEntries(
        COLOUR_STATES.map((state) => {
          const entry = isRecord(colorScript[state]) ? colorScript[state] : {};
          return [
            state,
            Object.freeze({
              satDelta: num(entry.satDelta, 0, -1, 1),
              valDelta: num(entry.valDelta, 0, -1, 1),
              hueDeg: num(entry.hueDeg, 0, -180, 180),
            }),
          ];
        }),
      ) as Record<ColourState, { satDelta: number; valDelta: number; hueDeg: number }>,
    ),
    pacing: Object.freeze({
      changeEverySec: pair(pacing.changeEverySec, d.pacing.changeEverySec, 0.5, 30),
      maxGapSec: num(pacing.maxGapSec, d.pacing.maxGapSec, 0.5, 60),
    }),
    compositing: readCompositingProfile(value.compositing) ?? d.compositing,
  });
};

// ---------------------------------------------------------------- lint

export type ProfileLintIssue = Readonly<{
  id: string;
  severity: "warn" | "block";
  detail: string;
}>;

const luminance = (hex: string): number => {
  const v = Number.parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
};
/** WCAG 2 contrast ratio of two sRGB colours (1..21). */
export const contrastRatio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
};

/**
 * Objective problems with a profile before it is stored: BLOCK for what makes text unreadable or
 * places the hero outside the safe area; WARN for proportions that are only heuristics.
 */
export const lintVisualLanguageProfile = (
  profile: VisualLanguageProfile,
): readonly ProfileLintIssue[] => {
  const issues: ProfileLintIssue[] = [];
  const { roles } = profile.palette;
  const caption = contrastRatio(roles.textOn, roles.textPlate);
  if (caption < profile.type.minContrast)
    issues.push({
      id: "caption_contrast",
      severity: "block",
      detail: `${caption} < ${profile.type.minContrast}`,
    });
  const accentOnPlate = contrastRatio(roles.accent, roles.textPlate);
  if (accentOnPlate < 3)
    issues.push({
      id: "accent_on_plate_contrast",
      severity: "warn",
      detail: `${accentOnPlate} < 3`,
    });
  const ink = contrastRatio(roles.ink, roles.bgFar);
  if (ink < 3)
    issues.push({ id: "ink_on_background_contrast", severity: "warn", detail: `${ink} < 3` });
  const [top, bottom] = profile.composition.heroYRange;
  if (top < SAFE_BOX.top / FRAME.height - 1e-9 || bottom > SAFE_BOX.bottom / FRAME.height + 1e-9)
    issues.push({ id: "hero_outside_safe_box", severity: "block", detail: `${top}..${bottom}` });
  if (
    profile.composition.heroXFractions.some(
      (x) => x < SAFE_BOX.left / FRAME.width || x > SAFE_BOX.right / FRAME.width,
    )
  )
    issues.push({
      id: "hero_x_outside_safe_box",
      severity: "block",
      detail: profile.composition.heroXFractions.join(","),
    });
  if (profile.type.captionPx[0] < 40)
    issues.push({
      id: "caption_too_small",
      severity: "warn",
      detail: `${profile.type.captionPx[0]} px < 40 px on a phone`,
    });
  const { dominant, secondary, accent } = profile.palette.areaMax;
  if (dominant + secondary + accent > 1.05)
    issues.push({
      id: "palette_area_over_one",
      severity: "warn",
      detail: `${dominant + secondary + accent}`,
    });
  const tiers = profile.value.areaTarget.reduce((sum, v) => sum + v, 0);
  if (Math.abs(tiers - 1) > 0.05)
    issues.push({ id: "value_tiers_not_one", severity: "warn", detail: `${tiers}` });
  const classes = profile.motion.durationClassesFrames;
  if (classes.some((c, i) => i > 0 && c <= (classes[i - 1] ?? 0)))
    issues.push({ id: "duration_classes_unsorted", severity: "warn", detail: classes.join(",") });
  return issues;
};

// ---------------------------------------------------------------- what the planner reads

/** Motion grammar numbers from a profile (the planner and composer read these, not GRAMMAR). */
export const grammarFromProfile = (profile: VisualLanguageProfile): typeof GRAMMAR => {
  const mid = ([a, b]: Pair) => (a + b) / 200;
  return Object.freeze({
    ...GRAMMAR,
    anticipationShare: mid(profile.motion.anticipationPct),
    overshoot: mid(profile.motion.overshootPct),
    deadFrameMs: (profile.motion.maxStaticFrames * 1000) / 30,
    durationClassesFrames: profile.motion.durationClassesFrames,
  }) as typeof GRAMMAR;
};
