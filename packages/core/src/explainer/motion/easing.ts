/** Easing curves for the motion engine: all map 0..1 to 0..1 (outBack and spring overshoot). */
export const clamp = (x: number, min = 0, max = 1): number => Math.max(min, Math.min(max, x));
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
/** Linear progress of t through [start, start + duration]. */
export const progress = (t: number, start: number, duration: number): number =>
  duration <= 0 ? (t >= start ? 1 : 0) : clamp((t - start) / duration);
export const inOutCubic = (x: number): number =>
  x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
export const outCubic = (x: number): number => 1 - (1 - x) ** 3;
export const outBack = (x: number): number => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
/** Damped spring 0 → 1 with a little overshoot; settles by x = 1.6. */
export const spring = (x: number): number =>
  x <= 0 ? 0 : x >= 1.6 ? 1 : 1 - Math.exp(-6 * x) * Math.cos(9 * x);

/** Nearest duration class, in ms, at 30 fps (motion grammar stage lengths). */
export const snapToClass = (ms: number, classesFrames: readonly number[]): number => {
  const frames = ms / (1000 / 30);
  let best = classesFrames[0] ?? 1;
  for (const c of classesFrames) if (Math.abs(c - frames) < Math.abs(best - frames)) best = c;
  return (best * 1000) / 30;
};

/**
 * Overshoot and settle, 0 → 1: rises to exactly 1 + overshoot at a third of the way, then dips
 * once under 1 and comes to rest at 1 (the "overshoot and settle" of the motion grammar).
 */
export const settle = (u: number, overshoot: number): number => {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (u < 1 / 3) return (1 + overshoot) * Math.sin((Math.PI / 2) * u * 3);
  const v = (u - 1 / 3) / (2 / 3);
  return 1 + overshoot * Math.cos(1.5 * Math.PI * v) * (1 - v) ** 2;
};

/**
 * Anticipation, execution, overshoot and settle over one entry: a dip to -depth during the
 * first `share` of k, then `settle`. Values run below 0 and above 1 on purpose; a pose blend
 * extrapolates them into a wind-up and an overshoot.
 */
export const anticipate = (k: number, share: number, depth: number, overshoot: number): number => {
  if (k <= 0) return 0;
  if (k < share) return -depth * Math.sin((Math.PI * k) / share);
  return settle((k - share) / (1 - share), overshoot);
};
