import type { RigBuild } from "../character-bible.js";
import type {
  BottomStyle,
  CharacterAccessory,
  CharacterPalette,
  CharacterWardrobe,
  HairStyle,
  TopStyle,
  WardrobePiece,
} from "../explainer-context.js";
import { n } from "../layout.js";

/**
 * stick-v1: the channel's original stick figure, drawn from a joint-angle table so every pose
 * is reproducible from code. Coordinates are relative to the feet (0,0) with y growing down;
 * the figure faces right (+x) and is mirrored for facing "left".
 */
export const POSES = [
  "neutral",
  "walking",
  "running",
  "sitting",
  "pointing",
  "thinking",
  "holding_phone",
  "typing",
  "surprised",
  "scared",
  "confused",
  "celebrating",
] as const;
export type PoseId = (typeof POSES)[number];
export const EXPRESSIONS = [
  "neutral",
  "happy",
  "sad",
  "angry",
  "confused",
  "worried",
  "surprised",
  "skeptical",
  "excited",
  // v2 slice 21 presets; the nine above keep their exact look (worried is the lite scared,
  // skeptical the lite smug).
  "scared",
  "smug",
  "tired",
  "embarrassed",
  "thinking",
] as const;
export type ExpressionId = (typeof EXPRESSIONS)[number];
/** Actions the motion renderer can perform with this rig (walk cycle, blends, hop, marks, aim, gaze, emotes). */
export const STICK_V1_ACTIONS = [
  "enter",
  "exit",
  "walk_to",
  "pose",
  "expression",
  "jump",
  "react",
  "point_at",
  "look_at",
  "emote",
] as const;

/** Degrees from straight down; positive swings toward the front (+x). */
type Limb = Readonly<{ upper: number; lower: number }>;
export type PoseAngles = Readonly<{
  frontArm: Limb;
  backArm: Limb;
  frontLeg: Limb;
  backLeg: Limb;
  /** Torso tilt in degrees; positive leans forward. */
  lean: number;
  /** Lifts the whole figure off the ground (jump), px. */
  lift?: number;
  seat?: boolean;
  prop?: "phone" | "laptop";
}>;

type Pose = PoseAngles;

const poses: Readonly<Record<PoseId, Pose>> = {
  neutral: {
    frontArm: { upper: 12, lower: 4 },
    backArm: { upper: -12, lower: -4 },
    frontLeg: { upper: 8, lower: 0 },
    backLeg: { upper: -8, lower: 0 },
    lean: 0,
  },
  walking: {
    frontArm: { upper: -30, lower: 20 },
    backArm: { upper: 32, lower: 25 },
    frontLeg: { upper: 28, lower: -8 },
    backLeg: { upper: -22, lower: 18 },
    lean: 4,
  },
  running: {
    frontArm: { upper: -55, lower: 95 },
    backArm: { upper: 70, lower: 80 },
    frontLeg: { upper: 60, lower: -70 },
    backLeg: { upper: -40, lower: 55 },
    lean: 16,
  },
  sitting: {
    frontArm: { upper: 30, lower: 55 },
    backArm: { upper: 18, lower: 50 },
    frontLeg: { upper: 88, lower: -88 },
    backLeg: { upper: 82, lower: -82 },
    lean: -2,
    seat: true,
  },
  pointing: {
    frontArm: { upper: 100, lower: -8 },
    backArm: { upper: -10, lower: -4 },
    frontLeg: { upper: 10, lower: 0 },
    backLeg: { upper: -10, lower: 0 },
    lean: 3,
  },
  thinking: {
    // Hand on chin: elbow forward at shoulder height, forearm folded back up.
    frontArm: { upper: 90, lower: 163 },
    backArm: { upper: 35, lower: 95 },
    frontLeg: { upper: 6, lower: 0 },
    backLeg: { upper: -6, lower: 0 },
    lean: -4,
  },
  holding_phone: {
    frontArm: { upper: 30, lower: 110 },
    backArm: { upper: -10, lower: -4 },
    frontLeg: { upper: 8, lower: 0 },
    backLeg: { upper: -8, lower: 0 },
    lean: 2,
    prop: "phone",
  },
  typing: {
    frontArm: { upper: 40, lower: 55 },
    backArm: { upper: 30, lower: 60 },
    frontLeg: { upper: 88, lower: -88 },
    backLeg: { upper: 84, lower: -84 },
    lean: 8,
    seat: true,
    prop: "laptop",
  },
  surprised: {
    frontArm: { upper: 110, lower: -45 },
    backArm: { upper: -110, lower: 45 },
    frontLeg: { upper: 12, lower: 0 },
    backLeg: { upper: -12, lower: 0 },
    lean: -8,
  },
  scared: {
    // Defensive: both hands up in front of the chest, leaning away.
    frontArm: { upper: 70, lower: 95 },
    backArm: { upper: 45, lower: 110 },
    frontLeg: { upper: 18, lower: 10 },
    backLeg: { upper: -24, lower: 12 },
    lean: -16,
  },
  confused: {
    // Shrug: elbows out, forearms and palms up.
    frontArm: { upper: 55, lower: 85 },
    backArm: { upper: -55, lower: -85 },
    frontLeg: { upper: 8, lower: 0 },
    backLeg: { upper: -8, lower: 0 },
    lean: -3,
  },
  celebrating: {
    // Wide V, clear of the head, feet off the ground.
    frontArm: { upper: 125, lower: 25 },
    backArm: { upper: -125, lower: -25 },
    frontLeg: { upper: 22, lower: -10 },
    backLeg: { upper: -22, lower: 10 },
    lean: 0,
    lift: 30,
  },
};

const HEAD_R = 58;
const TORSO = 180;
const UPPER_ARM = 100;
const LOWER_ARM = 88;
const THIGH = 100;
const SHIN = 92;
const LINE = 14;
const GAZE_PX = 12;
/** Head radius of the "big" head option: exactly 1.25x, so face and accessories scale cleanly. */
const BIG_HEAD_R = 72.5;

type Point = Readonly<{ x: number; y: number }>;
const rad = (degrees: number) => (degrees * Math.PI) / 180;
const step = (from: Point, degrees: number, length: number): Point => ({
  x: from.x + Math.sin(rad(degrees)) * length,
  y: from.y + Math.cos(rad(degrees)) * length,
});
const limb = (root: Point, angles: Limb, upper: number, lower: number) => {
  const joint = step(root, angles.upper, upper);
  const end = step(joint, angles.upper + angles.lower, lower);
  return {
    points: `${n(root.x)},${n(root.y)} ${n(joint.x)},${n(joint.y)} ${n(end.x)},${n(end.y)}`,
    path: [root, joint, end] as const,
    joint,
    end,
  };
};
type LimbPath = ReturnType<typeof limb>;
const at = (a: Point, b: Point, k: number): Point => ({
  x: a.x + (b.x - a.x) * k,
  y: a.y + (b.y - a.y) * k,
});

/** A garment piece around the segment a to b: half-width wa at a and wb at b, outlined like the rig. */
const band = (a: Point, b: Point, wa: number, wb: number, colour: string, line: string): string => {
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const px = -(b.y - a.y) / length;
  const py = (b.x - a.x) / length;
  const corners = [
    { x: a.x + px * wa, y: a.y + py * wa },
    { x: b.x + px * wb, y: b.y + py * wb },
    { x: b.x - px * wb, y: b.y - py * wb },
    { x: a.x - px * wa, y: a.y - py * wa },
  ]
    .map((corner) => `${n(corner.x)},${n(corner.y)}`)
    .join(" ");
  return `<polygon points="${corners}" fill="${colour}" stroke="${line}" stroke-width="6" stroke-linejoin="round"/>`;
};

type Garments = Readonly<{
  backSleeve: string;
  frontSleeve: string;
  backLeg: string;
  frontLeg: string;
  skirt: string;
  body: string;
}>;
const NO_GARMENTS: Garments = {
  backSleeve: "",
  frontSleeve: "",
  backLeg: "",
  frontLeg: "",
  skirt: "",
  body: "",
};
const sleeve = (top: WardrobePiece<TopStyle>, arm: LimbPath, shoulder: Point, line: string) =>
  top.style === "tshirt"
    ? band(shoulder, at(shoulder, arm.joint, 0.5), 17, 15, top.colour, line)
    : band(shoulder, arm.joint, 17, 15, top.colour, line) +
      band(arm.joint, at(arm.joint, arm.end, 0.8), 15, 13, top.colour, line);
const trouser = (bottoms: WardrobePiece<BottomStyle>, leg: LimbPath, hip: Point, line: string) =>
  bottoms.style === "pants"
    ? band(hip, leg.joint, 19, 16, bottoms.colour, line) +
      band(leg.joint, at(leg.joint, leg.end, 0.88), 16, 13, bottoms.colour, line)
    : bottoms.style === "shorts"
      ? band(hip, at(hip, leg.joint, 0.6), 19, 17, bottoms.colour, line)
      : "";

const garments = (
  wardrobe: CharacterWardrobe,
  body: Readonly<{
    hip: Point;
    neck: Point;
    shoulder: Point;
    lean: number;
    frontArm: LimbPath;
    backArm: LimbPath;
    frontLeg: LimbPath;
    backLeg: LimbPath;
  }>,
  line: string,
): Garments => {
  const { top, bottoms } = wardrobe;
  const waist = step(body.hip, -body.lean, 14);
  const belly = at(waist, body.neck, 0.28);
  const topBody = top
    ? (top.style === "hoodie"
        ? `<circle cx="${n(body.neck.x - 26)}" cy="${n(body.neck.y - 6)}" r="26" fill="${top.colour}" stroke="${line}" stroke-width="6"/>`
        : "") +
      band(waist, body.neck, 32, 38, top.colour, line) +
      (top.style === "shirt"
        ? `<path d="M${n(body.neck.x - 14)} ${n(body.neck.y + 4)} L${n(body.neck.x)} ${n(body.neck.y + 22)} L${n(body.neck.x + 14)} ${n(body.neck.y + 4)}" fill="none" stroke="${line}" stroke-width="5" stroke-linejoin="round"/>`
        : top.style === "hoodie"
          ? `<line x1="${n(belly.x - 22)}" y1="${n(belly.y)}" x2="${n(belly.x + 22)}" y2="${n(belly.y)}" stroke="${line}" stroke-width="5" stroke-linecap="round"/>`
          : "")
    : "";
  const legs = bottoms && bottoms.style !== "skirt" ? bottoms : undefined;
  return {
    backSleeve: top ? sleeve(top, body.backArm, body.shoulder, line) : "",
    frontSleeve: top ? sleeve(top, body.frontArm, body.shoulder, line) : "",
    backLeg: legs ? trouser(legs, body.backLeg, body.hip, line) : "",
    frontLeg: legs ? trouser(legs, body.frontLeg, body.hip, line) : "",
    skirt:
      bottoms?.style === "skirt"
        ? band(
            step(body.hip, 180 - body.lean, 8),
            step(body.hip, -body.lean, 100),
            30,
            64,
            bottoms.colour,
            line,
          )
        : "",
    body: topBody,
  };
};

/** Hair around the head centre h (radius r, facing +x): `back` goes behind the head circle. */
const hairLayers = (
  hair: WardrobePiece<HairStyle>,
  h: Point,
  r: number,
  line: string,
): Readonly<{ back: string; front: string }> => {
  const paint = `fill="${hair.colour}" stroke="${line}" stroke-width="6" stroke-linejoin="round"`;
  const p = (dx: number, dy: number) => `${n(h.x + dx * r)} ${n(h.y + dy * r)}`;
  // A cap of hair over the crown from ear to ear, heavier at the back.
  const cap = `<path d="M${p(-1.02, 0.05)} C${p(-1.1, -1.05)} ${p(0.95, -1.35)} ${p(1.02, -0.25)} Q${p(0.35, -0.72)} ${p(-0.35, -0.62)} Q${p(-0.8, -0.5)} ${p(-1.02, 0.05)} Z" ${paint}/>`;
  switch (hair.style) {
    case "short":
      return { back: "", front: cap };
    case "curly":
      return {
        back: "",
        front: [200, 225, 250, 275, 300, 325, 350]
          .map((degrees) => {
            const angle = rad(degrees);
            return `<circle cx="${n(h.x + Math.cos(angle) * r * 0.92)}" cy="${n(h.y + Math.sin(angle) * r * 0.92)}" r="${n(r * 0.3)}" ${paint}/>`;
          })
          .join(""),
      };
    case "long":
      return {
        back: `<path d="M${p(-1.08, -0.2)} Q${p(-1.25, 1.1)} ${p(-0.95, 1.5)} L${p(0.7, 1.5)} Q${p(1.1, 1)} ${p(1.05, -0.1)} Z" ${paint}/>`,
        front: cap,
      };
    case "bun":
      return {
        back: `<circle cx="${n(h.x - 0.55 * r)}" cy="${n(h.y - r)}" r="${n(0.42 * r)}" ${paint}/>`,
        front: cap,
      };
  }
};

const mouths: Readonly<Record<ExpressionId, string>> = {
  neutral: `<line x1="-16" y1="26" x2="16" y2="26"/>`,
  happy: `<path d="M-22 20 Q0 42 22 20"/>`,
  sad: `<path d="M-20 34 Q0 18 20 34"/>`,
  angry: `<path d="M-18 32 Q0 24 18 32"/>`,
  confused: `<path d="M-20 28 Q-8 20 2 28 T22 26"/>`,
  worried: `<path d="M-18 30 Q-6 24 6 30 T18 28"/>`,
  surprised: `<ellipse cx="0" cy="28" rx="11" ry="15"/>`,
  skeptical: `<line x1="-16" y1="30" x2="16" y2="22"/>`,
  excited: `<path d="M-24 16 Q0 48 24 16 Z"/>`,
  scared: `<path d="M-16 22 Q0 12 16 22 Q12 40 0 40 Q-12 40 -16 22 Z"/>`,
  smug: `<path d="M-18 28 Q2 32 20 18"/>`,
  tired: `<line x1="-12" y1="30" x2="12" y2="30"/>`,
  embarrassed: `<path d="M-14 28 Q-7 23 0 28 T14 28"/>`,
  thinking: `<path d="M-4 30 Q8 26 18 30"/>`,
};
/** [back brow tilt, front brow tilt]: positive raises the inner end. */
const brows: Readonly<Record<ExpressionId, readonly [number, number]>> = {
  neutral: [0, 0],
  happy: [-2, -2],
  sad: [7, 7],
  angry: [-9, -9],
  confused: [6, -6],
  worried: [9, 9],
  surprised: [-3, -3],
  skeptical: [0, -10],
  excited: [-5, -5],
  scared: [12, 12],
  smug: [-2, -8],
  tired: [5, 5],
  embarrassed: [8, 8],
  thinking: [4, -7],
};
/**
 * Extra face parameters of the v2 presets (slice 21): eye opening, pupil offset, cheek blush and
 * head tilt. The nine original expressions have none, so they draw exactly as before.
 */
const faceExtras: Readonly<
  Partial<
    Record<
      ExpressionId,
      Readonly<{ open: number; pupilY?: number; blush?: boolean; tiltDeg?: number }>
    >
  >
> = {
  scared: { open: 12, tiltDeg: -4 },
  smug: { open: 4, tiltDeg: 6 },
  tired: { open: 2.5, pupilY: 2, tiltDeg: 5 },
  embarrassed: { open: 6, pupilY: 3, blush: true, tiltDeg: -6 },
  thinking: { open: 7, pupilY: -5, tiltDeg: 8 },
};

type FaceMotion = Readonly<{
  /** 0 open, 1 closed. */
  blink?: number | undefined;
  /** Eyes glance -1 (back) … 1 (front). */
  look?: number | undefined;
  /**
   * Toward what the actor looks, rig coordinates (+x front, +y down), length 0 (ahead) to 1
   * (fully turned): the face features and glasses shift inside the head.
   */
  gaze?: Readonly<{ x: number; y: number }> | undefined;
  /** A mouth shape drawn instead of the expression's (lip-sync). */
  mouth?: string | undefined;
}>;

const face = (expression: ExpressionId, line: string, motion: FaceMotion = {}): string => {
  const extra = faceExtras[expression];
  const open =
    extra?.open ??
    (expression === "surprised" || expression === "excited"
      ? 11
      : expression === "skeptical"
        ? 4
        : 7);
  const ry = motion.blink ? n(Math.max(1, open * (1 - motion.blink))) : open;
  const look = motion.look ?? motion.gaze?.x;
  const dx = look ? look * 6 : 0;
  const ey = extra?.pupilY ? n(-8 + extra.pupilY) : "-8";
  const eyes = `<ellipse cx="${n(-20 + dx)}" cy="${ey}" rx="7" ry="${ry}" fill="${line}"/><ellipse cx="${n(20 + dx)}" cy="${ey}" rx="7" ry="${ry}" fill="${line}"/>`;
  const [back, front] = brows[expression];
  const browLines = `<line x1="-32" y1="${-30 + back}" x2="-10" y2="${-30 - back}"/><line x1="10" y1="${-30 - front}" x2="32" y2="${-30 + front}"/>`;
  const blush = extra?.blush
    ? `<ellipse cx="-30" cy="14" rx="10" ry="6" fill="#ff7a8a" fill-opacity="0.55"/><ellipse cx="30" cy="14" rx="10" ry="6" fill="#ff7a8a" fill-opacity="0.55"/>`
    : "";
  const features = `${blush}${eyes}<g fill="none" stroke="${line}" stroke-width="6" stroke-linecap="round">${browLines}${motion.mouth ?? mouths[expression]}</g>`;
  return extra?.tiltDeg ? `<g transform="rotate(${extra.tiltDeg})">${features}</g>` : features;
};

const accessoryLayer = (
  accessory: CharacterAccessory | undefined,
  head: Point,
  neck: Point,
  palette: CharacterPalette,
): string => {
  const { line, accent } = palette;
  switch (accessory) {
    case "glasses":
      return `<g fill="none" stroke="${line}" stroke-width="5"><circle cx="${n(head.x - 20)}" cy="${n(head.y - 8)}" r="16"/><circle cx="${n(head.x + 20)}" cy="${n(head.y - 8)}" r="16"/><line x1="${n(head.x - 4)}" y1="${n(head.y - 8)}" x2="${n(head.x + 4)}" y2="${n(head.y - 8)}"/></g>`;
    case "cap":
      return `<path d="M${n(head.x - 60)} ${n(head.y - 22)} Q${n(head.x)} ${n(head.y - 100)} ${n(head.x + 60)} ${n(head.y - 22)} L${n(head.x + 96)} ${n(head.y - 16)} L${n(head.x + 58)} ${n(head.y - 8)} Z" fill="${accent}" stroke="${line}" stroke-width="8" stroke-linejoin="round"/>`;
    case "tie":
      return `<path d="M${n(neck.x)} ${n(neck.y + 8)} l12 26 l-12 64 l-12 -64 z" fill="${accent}" stroke="${line}" stroke-width="4" stroke-linejoin="round"/>`;
    case "headphones":
      return `<path d="M${n(head.x - 66)} ${n(head.y)} A66 66 0 0 1 ${n(head.x + 66)} ${n(head.y)}" fill="none" stroke="${line}" stroke-width="10"/><rect x="${n(head.x - 80)}" y="${n(head.y - 16)}" width="24" height="42" rx="8" fill="${accent}" stroke="${line}" stroke-width="4"/><rect x="${n(head.x + 56)}" y="${n(head.y - 16)}" width="24" height="42" rx="8" fill="${accent}" stroke="${line}" stroke-width="4"/>`;
    default:
      return "";
  }
};

/** Joint angles of a named pose, for blending between poses frame by frame. */
export const poseAngles = (pose: PoseId): PoseAngles => poses[pose];

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mixLimb = (a: Limb, b: Limb, k: number): Limb => ({
  upper: mix(a.upper, b.upper, k),
  lower: mix(a.lower, b.lower, k),
});
/** Interpolates two poses; seat and held prop switch at the halfway point. */
export const blendPoses = (a: PoseAngles, b: PoseAngles, k: number): PoseAngles => {
  const late = k >= 0.5 ? b : a;
  return {
    frontArm: mixLimb(a.frontArm, b.frontArm, k),
    backArm: mixLimb(a.backArm, b.backArm, k),
    frontLeg: mixLimb(a.frontLeg, b.frontLeg, k),
    backLeg: mixLimb(a.backLeg, b.backLeg, k),
    lean: mix(a.lean, b.lean, k),
    ...(a.lift !== undefined || b.lift !== undefined
      ? { lift: mix(a.lift ?? 0, b.lift ?? 0, k) }
      : {}),
    ...(late.seat ? { seat: true } : {}),
    ...(late.prop ? { prop: late.prop } : {}),
  };
};

/** Deterministic 0..1 value for (seed, i): an integer hash, identical on every machine. */
const noise = (seed: number, i: number): number => {
  let h = Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4_294_967_296;
};
/** A character's line seed: the same hand draws the same character in every scene. */
export const sketchSeed = (key: string): number =>
  [...key].reduce((sum, ch) => (Math.imul(sum, 31) + ch.charCodeAt(0)) >>> 0, 17);
/**
 * A hand-drawn stroke through points: each segment bows by up to 4% of its length, seeded per
 * stroke, so it reads as ink without boiling from frame to frame. Geometry, not an SVG filter:
 * librsvg filters cost ~2 s per frame (measured 2026-09-30).
 */
const sketchPath = (points: readonly Point[], seed: number): string => {
  const [first, ...rest] = points;
  if (!first) return "";
  let d = `M${n(first.x)} ${n(first.y)}`;
  let from = first;
  rest.forEach((to, i) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    const bow = (noise(seed, i) - 0.5) * 0.08 * length;
    const mid = at(from, to, 0.5);
    d += ` Q${n(mid.x - ((to.y - from.y) / length) * bow)} ${n(mid.y + ((to.x - from.x) / length) * bow)} ${n(to.x)} ${n(to.y)}`;
    from = to;
  });
  return d;
};
/** A hand-drawn head outline: eight control points whose radius wobbles by up to 3%. */
const sketchCircle = (c: Point, r: number, seed: number): string => {
  const points = Array.from({ length: 8 }, (_, i) => {
    const angle = (i / 8) * 2 * Math.PI;
    // 1.04: a quadratic through edge midpoints sits ~4% inside its control points.
    const k = 1.04 * (1 + (noise(seed, i) - 0.5) * 0.06);
    return { x: c.x + Math.cos(angle) * r * k, y: c.y + Math.sin(angle) * r * k };
  });
  const start = at(points[7] as Point, points[0] as Point, 0.5);
  let d = `M${n(start.x)} ${n(start.y)}`;
  points.forEach((point, i) => {
    const next = at(point, points[(i + 1) % points.length] as Point, 0.5);
    d += ` Q${n(point.x)} ${n(point.y)} ${n(next.x)} ${n(next.y)}`;
  });
  return `${d} Z`;
};

type StickmanLook = Readonly<{
  expression: ExpressionId;
  palette: CharacterPalette;
  x: number;
  baselineY: number;
  scale?: number | undefined;
  facing?: "left" | "right" | undefined;
  accessory?: CharacterAccessory | undefined;
  wardrobe?: CharacterWardrobe | undefined;
}>;

/**
 * One animation frame of the rig: resolved joint angles plus face motion. Motion frames draw
 * hands, feet and a ground shadow; stills (renderStickman) keep the original figure.
 */
export const renderStickmanFrame = (
  input: StickmanLook &
    FaceMotion &
    Readonly<{
      angles: PoseAngles;
      lift?: number | undefined;
      extremities?: boolean | undefined;
      /** Painted backgrounds: a wider, darker contact shadow so the figure stands on the floor. */
      grounded?: boolean | undefined;
      /** Niche sketch style: seeded hand-drawn strokes instead of clean lines. */
      sketch?: Readonly<{ seed: number }> | undefined;
      /**
       * Compositing profile light (v2 slice 14): shadow offset in px at scale 1 (screen space,
       * mirrored for a left-facing actor) and an opacity multiplier; 0 draws no shadow.
       * Absent keeps today's shadow byte for byte.
       */
      shadowCast?: Readonly<{ dx: number; dy: number; strength: number }> | undefined;
      /**
       * Character bible build (v2 slice 19): archetype multipliers on limb, torso, head and
       * stroke, a lean offset and a head outline scale. Absent draws today's figure.
       */
      build?: RigBuild | undefined;
    }>,
): string => {
  const build = input.build;
  const pose = build?.lean
    ? { ...input.angles, lean: input.angles.lean + build.lean }
    : input.angles;
  const thigh = THIGH * (build?.limb ?? 1);
  const shin = SHIN * (build?.limb ?? 1);
  const upperArm = UPPER_ARM * (build?.limb ?? 1);
  const lowerArm = LOWER_ARM * (build?.limb ?? 1);
  const torso = TORSO * (build?.torso ?? 1);
  const lineWidth = build ? Math.round(LINE * build.stroke * 10) / 10 : LINE;
  const { line, fill, accent } = input.palette;
  const headR = (input.wardrobe?.head === "big" ? BIG_HEAD_R : HEAD_R) * (build?.head ?? 1);
  const headK = headR / HEAD_R;
  const lift = (pose.lift ?? 0) + (input.lift ?? 0);
  // Hip height is derived from the legs so the lower foot always touches the ground.
  const footDrop = (leg: Limb) =>
    step(step({ x: 0, y: 0 }, leg.upper, thigh), leg.upper + leg.lower, shin).y;
  const hip: Point = {
    x: 0,
    y: -Math.max(footDrop(pose.frontLeg), footDrop(pose.backLeg)) - lift,
  };
  const neck = step(hip, 180 - pose.lean, torso);
  const shoulder = step(neck, -pose.lean, 18);
  const head: Point = step(neck, 180 - pose.lean, headR + 8);
  const faceAt: Point = {
    x: head.x + (input.gaze?.x ?? 0) * GAZE_PX,
    y: head.y + (input.gaze?.y ?? 0) * GAZE_PX,
  };
  const frontArm = limb(shoulder, pose.frontArm, upperArm, lowerArm);
  const backArm = limb(shoulder, pose.backArm, upperArm, lowerArm);
  const frontLeg = limb(hip, pose.frontLeg, thigh, shin);
  const backLeg = limb(hip, pose.backLeg, thigh, shin);
  const stroke = `fill="none" stroke="${line}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"`;
  const pencil = (points: readonly Point[], salt: number): string => {
    const seed = (input.sketch?.seed ?? 0) + salt * 7_919;
    const offset = points.map((point) => ({ x: point.x + 3, y: point.y - 2 }));
    return `<path ${stroke} d="${sketchPath(points, seed)}"/><path fill="none" stroke="${line}" stroke-width="3" stroke-opacity="0.45" stroke-linecap="round" d="${sketchPath(offset, seed + 1)}"/>`;
  };
  const seat = pose.seat
    ? `<rect x="-40" y="${n(hip.y + 10)}" width="130" height="${n(-hip.y - 10)}" rx="10" fill="${accent}" fill-opacity="0.25" stroke="${line}" stroke-width="6"/>`
    : "";
  const prop =
    pose.prop === "phone"
      ? `<rect x="${n(frontArm.end.x - 14)}" y="${n(frontArm.end.y - 70)}" width="44" height="78" rx="8" fill="${accent}" stroke="${line}" stroke-width="6"/>`
      : pose.prop === "laptop"
        ? `<path d="M${n(frontArm.end.x - 70)} ${n(frontArm.end.y)} h150 l-24 -96 h-110 z" fill="${fill}" stroke="${line}" stroke-width="8" stroke-linejoin="round"/>`
        : "";
  const hand = (end: Point) =>
    input.extremities ? `<circle cx="${n(end.x)}" cy="${n(end.y)}" r="10" fill="${line}"/>` : "";
  const foot = (end: Point) =>
    input.extremities
      ? `<ellipse cx="${n(end.x + 12)}" cy="${n(end.y - 2)}" rx="17" ry="8" fill="${line}"/>`
      : "";
  const cast = input.shadowCast;
  const shade = (opacity: number): string =>
    cast ? String(Math.round(Math.min(1, opacity * cast.strength) * 1000) / 1000) : String(opacity);
  const sx = cast ? (input.facing === "left" ? -cast.dx : cast.dx) : 0;
  const sy = cast?.dy ?? 0;
  const shadow =
    !input.extremities || cast?.strength === 0
      ? ""
      : input.grounded
        ? `<ellipse cx="${n(sx)}" cy="${n(8 + sy)}" rx="${n(118 - lift * 0.8)}" ry="24" fill="#000" fill-opacity="${shade(0.1)}"/><ellipse cx="${n(sx)}" cy="${n(6 + sy)}" rx="${n(84 - lift * 0.6)}" ry="14" fill="#000" fill-opacity="${shade(0.24)}"/>`
        : `<ellipse cx="${n(sx)}" cy="${n(6 + sy)}" rx="${n(80 - lift * 0.6)}" ry="13" fill="#000" fill-opacity="${shade(0.09)}"/>`;
  const dress = input.wardrobe
    ? garments(
        input.wardrobe,
        { hip, neck, shoulder, lean: pose.lean, frontArm, backArm, frontLeg, backLeg },
        line,
      )
    : NO_GARMENTS;
  const hair = input.wardrobe?.hair
    ? hairLayers(input.wardrobe.hair, head, headR, line)
    : { back: "", front: "" };
  const accessoryAt = input.accessory === "glasses" ? faceAt : head;
  const headAccessory = accessoryLayer(input.accessory, accessoryAt, neck, input.palette);
  // Head accessories grow with a big head around their own anchor; a tie stays at the neck.
  const accessory =
    headK === 1 || input.accessory === "tie" || headAccessory === ""
      ? headAccessory
      : `<g transform="translate(${n(accessoryAt.x)},${n(accessoryAt.y)}) scale(${headK}) translate(${n(-accessoryAt.x)},${n(-accessoryAt.y)})">${headAccessory}</g>`;
  const flip = input.facing === "left" ? " scale(-1,1)" : "";
  const headOutline = (outline: string): string =>
    build && (build.headShape.rx !== 1 || build.headShape.ry !== 1)
      ? `<g transform="translate(${n(head.x)},${n(head.y)}) scale(${build.headShape.rx},${build.headShape.ry}) translate(${n(-head.x)},${n(-head.y)})">${outline}</g>`
      : outline;
  return (
    `<g transform="translate(${n(input.x)},${n(input.baselineY)}) scale(${Math.round((input.scale ?? 1) * 100) / 100})${flip}">` +
    shadow +
    seat +
    hair.back +
    (input.sketch ? pencil(backArm.path, 1) : `<polyline ${stroke} points="${backArm.points}"/>`) +
    dress.backSleeve +
    hand(backArm.end) +
    (input.sketch ? pencil(backLeg.path, 2) : `<polyline ${stroke} points="${backLeg.points}"/>`) +
    dress.backLeg +
    foot(backLeg.end) +
    (input.sketch
      ? pencil([hip, neck], 3)
      : `<line ${stroke} x1="${n(hip.x)}" y1="${n(hip.y)}" x2="${n(neck.x)}" y2="${n(neck.y)}"/>`) +
    (input.sketch
      ? pencil(frontLeg.path, 4)
      : `<polyline ${stroke} points="${frontLeg.points}"/>`) +
    dress.frontLeg +
    foot(frontLeg.end) +
    dress.skirt +
    dress.body +
    (input.sketch
      ? headOutline(
          `<path d="${sketchCircle(head, headR, input.sketch.seed + 6 * 7_919)}" fill="${fill}" stroke="${line}" stroke-width="${lineWidth}" stroke-linejoin="round"/>`,
        )
      : build && (build.headShape.rx !== 1 || build.headShape.ry !== 1)
        ? `<ellipse cx="${n(head.x)}" cy="${n(head.y)}" rx="${n(headR * build.headShape.rx)}" ry="${n(headR * build.headShape.ry)}" fill="${fill}" stroke="${line}" stroke-width="${lineWidth}"/>`
        : `<circle cx="${n(head.x)}" cy="${n(head.y)}" r="${headR}" fill="${fill}" stroke="${line}" stroke-width="${lineWidth}"/>`) +
    hair.front +
    `<g transform="translate(${n(faceAt.x)},${n(faceAt.y)})${headK === 1 ? "" : ` scale(${headK})`}">${face(input.expression, line, input)}</g>` +
    accessory +
    (input.sketch
      ? pencil(frontArm.path, 5)
      : `<polyline ${stroke} points="${frontArm.points}"/>`) +
    dress.frontSleeve +
    hand(frontArm.end) +
    prop +
    `</g>`
  );
};

/** Head centre above the feet at scale 1, for placing reaction marks. */
export const HEAD_TOP_Y = -(THIGH + SHIN + TORSO + HEAD_R * 2 + 8);
/** Shoulder height above the feet at scale 1 with straight legs, for aiming an arm. */
export const SHOULDER_Y = -(THIGH + SHIN + TORSO - 18);
/** Head centre above the feet at scale 1 with straight legs, for aiming a gaze. */
export const HEAD_Y = -(THIGH + SHIN + TORSO + HEAD_R + 8);

export const renderStickman = (input: StickmanLook & Readonly<{ pose: PoseId }>): string => {
  const { pose, ...look } = input;
  return renderStickmanFrame({ ...look, angles: poses[pose] });
};
