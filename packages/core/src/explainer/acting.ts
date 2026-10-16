import type { GRAMMAR } from "./motion/tuning.js";

/**
 * ActingProfile (Stickman v2 spec 11.3, slice 20): personality as timing. Ten scalars on the
 * character bible; the motion grammar reads them per actor. All are 0..1 except
 * reactionDelayMs (80..450). NEUTRAL (0.5 everywhere, 250 ms) reproduces the plain grammar.
 */
export type ActingProfile = Readonly<{
  energy: number;
  amplitude: number;
  posture: number;
  weight: number;
  snap: number;
  reactionDelayMs: number;
  exaggeration: number;
  fidget: number;
  gazeTension: number;
  gestureRate: number;
}>;

export const NEUTRAL_ACTING: ActingProfile = Object.freeze({
  energy: 0.5,
  amplitude: 0.5,
  posture: 0.5,
  weight: 0.5,
  snap: 0.5,
  reactionDelayMs: 250,
  exaggeration: 0.5,
  fidget: 0.5,
  gazeTension: 0.5,
  gestureRate: 0.5,
});

/** Six presets (fixtures; PROPOSAL values for the owner's profile-swap review). */
export const ACTING_PRESETS: Readonly<Record<string, ActingProfile>> = Object.freeze({
  neutral: NEUTRAL_ACTING,
  energetic: {
    ...NEUTRAL_ACTING,
    energy: 0.9,
    amplitude: 0.8,
    snap: 0.8,
    exaggeration: 0.8,
    fidget: 0.8,
    reactionDelayMs: 120,
    posture: 0.7,
  },
  calm: {
    ...NEUTRAL_ACTING,
    energy: 0.25,
    amplitude: 0.35,
    snap: 0.3,
    exaggeration: 0.3,
    fidget: 0.2,
    reactionDelayMs: 380,
    posture: 0.6,
  },
  nervous: {
    ...NEUTRAL_ACTING,
    energy: 0.7,
    amplitude: 0.4,
    snap: 0.7,
    fidget: 0.95,
    gazeTension: 0.9,
    reactionDelayMs: 100,
    posture: 0.3,
  },
  weary: {
    ...NEUTRAL_ACTING,
    energy: 0.15,
    amplitude: 0.45,
    weight: 0.9,
    snap: 0.2,
    exaggeration: 0.4,
    fidget: 0.3,
    reactionDelayMs: 450,
    posture: 0.1,
  },
  showman: {
    ...NEUTRAL_ACTING,
    energy: 0.75,
    amplitude: 1,
    snap: 0.6,
    exaggeration: 1,
    gestureRate: 0.9,
    reactionDelayMs: 180,
    posture: 0.8,
  },
});

const unit = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** A stored bible.acting record, clamped; absent fields are neutral. */
export const readActingProfile = (value: unknown): ActingProfile | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const n = NEUTRAL_ACTING;
  const delay =
    typeof v.reactionDelayMs === "number" && Number.isFinite(v.reactionDelayMs)
      ? Math.min(450, Math.max(80, v.reactionDelayMs))
      : n.reactionDelayMs;
  return Object.freeze({
    energy: unit(v.energy, n.energy),
    amplitude: unit(v.amplitude, n.amplitude),
    posture: unit(v.posture, n.posture),
    weight: unit(v.weight, n.weight),
    snap: unit(v.snap, n.snap),
    reactionDelayMs: delay,
    exaggeration: unit(v.exaggeration, n.exaggeration),
    fidget: unit(v.fidget, n.fidget),
    gazeTension: unit(v.gazeTension, n.gazeTension),
    gestureRate: unit(v.gestureRate, n.gestureRate),
  });
};

/**
 * Piecewise-linear factor through (0, low), (0.5, 1), (1, high). The spec writes plain lerps
 * (e.g. lerp(0.7, 1.4, energy)), which give 1.05 at the neutral 0.5; passing through 1 keeps the
 * neutral profile identical to the plain grammar (recorded spec drift).
 */
export const actingFactor = (x: number, low: number, high: number): number =>
  x <= 0.5 ? low + (1 - low) * (x / 0.5) : 1 + (high - 1) * ((x - 0.5) / 0.5);

/** The grammar numbers one actor uses: timing from energy and snap, size from amplitude. */
export const actingGrammar = (g: typeof GRAMMAR, acting: ActingProfile): typeof GRAMMAR => {
  const speed = actingFactor(acting.energy, 0.7, 1.4);
  const size = actingFactor(acting.amplitude, 0.6, 1.5);
  const over = actingFactor(acting.exaggeration, 0.5, 2);
  const windUp = actingFactor(acting.snap, 1.3, 0.7);
  const fidget = actingFactor(acting.fidget, 0.5, 2);
  const gaze = actingFactor(acting.gazeTension, 0.5, 2);
  return Object.freeze({
    ...g,
    anticipationShare: g.anticipationShare * windUp,
    anticipationDepth: g.anticipationDepth * size,
    overshoot: Math.min(0.45, g.overshoot * over),
    gazeOvershoot: Math.min(0.35, g.gazeOvershoot * gaze),
    pointEntryMs: g.pointEntryMs / speed,
    gazeEntryMs: g.gazeEntryMs / speed,
    walkStartMs: g.walkStartMs / speed,
    walkStopMs: g.walkStopMs / speed,
    walkStartLeanDeg: g.walkStartLeanDeg * size,
    walkStopLeanDeg: g.walkStopLeanDeg * size,
    walkBobPx: g.walkBobPx * size,
    holdSwayDeg: g.holdSwayDeg * fidget,
    holdSwayPeriodMs: g.holdSwayPeriodMs / fidget,
  }) as typeof GRAMMAR;
};

/** Degrees of lean from posture: 0.5 upright as today, 0 slumps forward, 1 leans back proud. */
export const postureLeanDeg = (acting: ActingProfile): number => (0.5 - acting.posture) * 12;
