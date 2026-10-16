/**
 * Shot kinds (Stickman v2 spec 14.3, slice 23). The first three are today's; the rest add a
 * scale mapping (establishing 0.7, two_shot 0.9, over_shoulder 1.15, insert 1.2, pov 1.0) and
 * per-kind rules the validator reads. Scales of the original three are unchanged.
 */
export const SHOT_KINDS = [
  "wide",
  "medium",
  "close",
  "establishing",
  "two_shot",
  "over_shoulder",
  "insert",
  "pov",
] as const;
export type ShotKind = (typeof SHOT_KINDS)[number];

export const SHOT_SCALE: Readonly<Record<ShotKind, number>> = Object.freeze({
  wide: 0.8,
  medium: 1,
  close: 1.3,
  establishing: 0.7,
  two_shot: 0.9,
  over_shoulder: 1.15,
  insert: 1.2,
  pov: 1,
});
export const PROP_SHOT_SCALE: Readonly<Record<ShotKind, number>> = Object.freeze({
  wide: 0.85,
  medium: 1,
  close: 1.1,
  establishing: 0.8,
  two_shot: 0.95,
  over_shoulder: 1.05,
  insert: 1.3,
  pov: 1,
});

/** What each kind may hold. Absent limits mean "as today" (the scene-wide 3 actors). */
export const SHOT_RULES: Readonly<
  Record<ShotKind, Readonly<{ minActors: number; maxActors: number; needsProp?: boolean }>>
> = Object.freeze({
  wide: { minActors: 0, maxActors: 3 },
  medium: { minActors: 0, maxActors: 3 },
  close: { minActors: 0, maxActors: 3 },
  establishing: { minActors: 0, maxActors: 3 },
  two_shot: { minActors: 2, maxActors: 2 },
  over_shoulder: { minActors: 2, maxActors: 2 },
  insert: { minActors: 0, maxActors: 0, needsProp: true },
  pov: { minActors: 0, maxActors: 1 },
});
