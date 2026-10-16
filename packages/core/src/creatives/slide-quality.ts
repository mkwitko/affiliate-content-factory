import type { CreativeBoxKey } from "./creative-document.js";
import type { PixelBox } from "./creative-renderer.js";
import type { PlatformPreset } from "./platform-presets.js";
import type { SubjectCollision } from "./subject-layout.js";

/**
 * Deterministic legibility QA for rendered in-scene slides: geometry from the recorded boxes
 * plus text contrast measured on the pixels by a provider (core stays free of image libraries).
 * Only hard failures block; everything else warns. Weights are versioned like the pre-publish score.
 */
export const SLIDE_QUALITY_VERSION = "slide-quality-v1";
export const SLIDE_QUALITY_WEIGHTS = Object.freeze({
  in_canvas: 30,
  ui_blocked: 20,
  contrast: 30,
  safe_area: 10,
  text_overlap: 5,
  subject_collision: 5,
  text_overflow: 5,
});
/** Ink may leave its layout box by this share of the canvas width before it counts as overflow. */
export const OVERFLOW_TOLERANCE = 0.02;
/**
 * WCAG AA passes at 4.5. Contrast only warns: on real renders (2026-10-08) the measurer read
 * 2.4-3.4 for headlines that stay legible through their white halo, which it cannot see.
 * Make it block again only after it agrees with owner labels.
 */
export const CONTRAST_PASS = 4.5;

export type QualityVerdict = "pass" | "warn" | "block";
export type QualityCheck = Readonly<{
  id: keyof typeof SLIDE_QUALITY_WEIGHTS;
  result: "pass" | "warn" | "fail" | "n/a";
  weight: number;
  detail?: string;
}>;
export type CreativeQualityReport = Readonly<{
  version: typeof SLIDE_QUALITY_VERSION;
  verdict: QualityVerdict;
  score: number;
  checks: readonly QualityCheck[];
}>;
/** Contrast ratio (1..21) of `textColour` against the pixels behind `box`; null when unmeasurable. */
export type ContrastMeasurer = (
  image: Uint8Array,
  box: PixelBox,
  textColour: string,
) => Promise<number | null>;

type Canvas = Readonly<{ w: number; h: number }>;
type Zone = Readonly<{ x: number; y: number; w: number; h: number }>;

const TEXT_BOXES: readonly CreativeBoxKey[] = ["headline", "body", "price", "cta", "disclosure"];
const inside = (b: PixelBox, z: PixelBox) =>
  b.x >= z.x && b.y >= z.y && b.x + b.w <= z.x + z.w && b.y + b.h <= z.y + z.h;
const overlaps = (a: PixelBox, b: PixelBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const px = (z: Zone, c: Canvas): PixelBox => ({
  x: z.x * c.w,
  y: z.y * c.h,
  w: z.w * c.w,
  h: z.h * c.h,
});

export const judgeSlideQuality = async (input: {
  preset: PlatformPreset;
  canvas: Canvas;
  boxes: Readonly<Partial<Record<CreativeBoxKey, PixelBox>>>;
  /**
   * Measured ink per text element (renderer, brief 13). When present, geometry is judged on
   * these pixels instead of the layout boxes, and ink outside its box warns `text_overflow`.
   */
  ink?: Readonly<Partial<Record<CreativeBoxKey, PixelBox>>> | undefined;
  /** Colour each text box is drawn in, `#rrggbb`. */
  textColours: Readonly<Partial<Record<CreativeBoxKey, string>>>;
  collisions?: readonly SubjectCollision[];
  image: Uint8Array;
  measureContrast?: ContrastMeasurer;
}): Promise<CreativeQualityReport> => {
  const { preset, canvas } = input;
  const text = TEXT_BOXES.flatMap((key) => {
    const box = input.ink?.[key] ?? input.boxes[key];
    return box ? [{ key, box }] : [];
  });
  const w = SLIDE_QUALITY_WEIGHTS;
  const checks: QualityCheck[] = [];
  const geometry = (
    id: keyof typeof SLIDE_QUALITY_WEIGHTS,
    bad: readonly string[],
    failure: "warn" | "fail",
  ) =>
    checks.push({
      id,
      result: bad.length > 0 ? failure : "pass",
      weight: w[id],
      ...(bad.length > 0 ? { detail: bad.join(", ") } : {}),
    });
  geometry(
    "in_canvas",
    text.filter((t) => !inside(t.box, { x: 0, y: 0, ...canvas })).map((t) => t.key),
    "fail",
  );
  const bands = preset.uiBlocked.map((z) => px(z, canvas));
  geometry(
    "ui_blocked",
    text.filter((t) => bands.some((b) => overlaps(t.box, b))).map((t) => t.key),
    "fail",
  );
  const safe = px(preset.safe, canvas);
  geometry(
    "safe_area",
    text.filter((t) => !inside(t.box, safe)).map((t) => t.key),
    "warn",
  );
  const clash: string[] = [];
  text.forEach((a, i) => {
    for (const b of text.slice(i + 1)) if (overlaps(a.box, b.box)) clash.push(`${a.key}/${b.key}`);
  });
  geometry("text_overlap", clash, "warn");
  if (input.ink) {
    const slack = canvas.w * OVERFLOW_TOLERANCE;
    const grown = (b: PixelBox): PixelBox => ({
      x: b.x - slack,
      y: b.y - slack,
      w: b.w + 2 * slack,
      h: b.h + 2 * slack,
    });
    geometry(
      "text_overflow",
      TEXT_BOXES.filter((key) => {
        const ink = input.ink?.[key];
        const box = input.boxes[key];
        return ink !== undefined && box !== undefined && !inside(ink, grown(box));
      }),
      "warn",
    );
  } else checks.push({ id: "text_overflow", result: "n/a", weight: w.text_overflow });
  geometry(
    "subject_collision",
    (input.collisions ?? []).map((c) => `${c.block}:${c.kind}`),
    "warn",
  );

  if (!input.measureContrast) checks.push({ id: "contrast", result: "n/a", weight: w.contrast });
  else {
    const low: string[] = [];
    let worst = Number.POSITIVE_INFINITY;
    let unmeasured = false;
    for (const { key, box } of text) {
      const colour = input.textColours[key];
      if (!colour) continue;
      let ratio: number | null = null;
      try {
        ratio = await input.measureContrast(input.image, box, colour);
      } catch {
        // Unmeasured is never a pass.
      }
      if (ratio === null) unmeasured = true;
      else if (ratio < CONTRAST_PASS) {
        worst = Math.min(worst, ratio);
        low.push(`${key} ${ratio.toFixed(2)}`);
      }
    }
    const detail = [...low, ...(unmeasured ? ["unmeasured"] : [])].join("; ");
    checks.push({
      id: "contrast",
      result: detail ? "warn" : "pass",
      weight: w.contrast,
      ...(detail ? { detail } : {}),
    });
  }

  const applicable = checks.filter((c) => c.result !== "n/a");
  const total = applicable.reduce((sum, c) => sum + c.weight, 0);
  const earned = applicable.reduce(
    (sum, c) => sum + (c.result === "pass" ? c.weight : c.result === "warn" ? c.weight / 2 : 0),
    0,
  );
  return {
    version: SLIDE_QUALITY_VERSION,
    verdict: checks.some((c) => c.result === "fail")
      ? "block"
      : checks.some((c) => c.result === "warn")
        ? "warn"
        : "pass",
    score: Math.round((100 * earned) / total),
    checks,
  };
};

const rank: Readonly<Record<QualityVerdict, number>> = { pass: 0, warn: 1, block: 2 };
export const worstQualityVerdict = (verdicts: readonly QualityVerdict[]): QualityVerdict =>
  verdicts.reduce<QualityVerdict>((worst, v) => (rank[v] > rank[worst] ? v : worst), "pass");
