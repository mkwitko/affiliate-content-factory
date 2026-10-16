/**
 * Motion grammar tunables (Stickman v2 spec section 15.1, slice 15). Every number the grammar
 * uses lives here, labelled HYPOTHESIS: research defaults until the owner approves the motion
 * test and slice 18 writes the measured VisualLanguageProfile. Grammar off never reads them.
 */
export const GRAMMAR = Object.freeze({
  /** Share of an entry spent winding up the other way before the move (anticipation). */
  anticipationShare: 0.2,
  /** How far the wind-up goes, as a share of the move (a blend below 0). */
  anticipationDepth: 0.14,
  /** First-peak overshoot past the target, as a share of the move. */
  overshoot: 0.12,
  /** Arm raise for point_at: longest entry, and the most of the action it may take. */
  pointEntryMs: 600,
  pointEntryShare: 0.45,
  /** Gaze settles with a small overshoot and no wind-up (eyes lead). */
  gazeEntryMs: 260,
  gazeOvershoot: 0.08,
  /** Walk: lean back before the first step, lean forward and settle after the last. */
  walkStartMs: 160,
  walkStartLeanDeg: -6,
  walkStopMs: 320,
  walkStopLeanDeg: 5,
  /** Vertical bob per step while walking, px at scale 1 (the body travels on arcs). */
  walkBobPx: 7,
  /** Moving hold: slow weight shift of an idle actor, degrees and period. */
  holdSwayDeg: 1.2,
  holdSwayPeriodMs: 3_400,
  /** A scene with nothing moving for this long is flagged `dead_frames:<index>`. */
  deadFrameMs: 2_000,
  /** Stage lengths snap to these frame counts at 30 fps (duration classes). */
  durationClassesFrames: Object.freeze([2, 3, 4, 6, 8, 12, 18, 24] as const),
});

/**
 * Motion budget (spec section 15.3, slice 16): WARN-level only, never a rejection. Costs are
 * HYPOTHESIS attention units; the window sum is what one viewer can follow at once.
 */
export const BUDGET = Object.freeze({
  windowMs: 1_500,
  maxPerWindow: 6,
  actionCost: Object.freeze({
    enter: 3,
    exit: 3,
    walk_to: 3,
    jump: 3,
    emote: 3,
    point_at: 2,
    pose: 2,
    look_at: 1,
    expression: 1,
    react: 1,
  } as const),
  priorityScale: Object.freeze({ primary: 1, secondary: 0.5, ambient: 0.25 } as const),
  /** Camera moves cost attention for the whole scene; `handheld` and `none` are free. */
  cameraCost: Object.freeze({
    none: 0,
    handheld: 0,
    slow_zoom_in: 1,
    slow_zoom_out: 1,
    pan_left: 1,
    pan_right: 1,
    low_angle: 1,
    push_in: 2,
  } as const),
  overlayCost: 2,
  propCost: 1,
  diagramCost: 3,
  /**
   * Primary actions (other than an entrance) should not start within this of a cut: the eye
   * lands first. 500 ms covers the second narration word at 120-180 wpm.
   */
  cutHoldMs: 500,
  /** Longest stretch without a primary beat (action, overlay, cut) before a cadence warning. */
  maxCadenceGapMs: 4_000,
});

/** Dialogue timing (spec section 16, slice 32). HYPOTHESIS defaults, tunable by profile later. */
export const DIALOGUE = Object.freeze({
  speakerGapMs: 180,
  sameSpeakerGapMs: 300,
  maxPauseMs: 2_000,
  /** How far an interrupting line starts under the previous one. */
  interruptOverlapMs: 300,
  /** Gain applied to the interrupted line's tail. */
  interruptDuckDb: -10,
  maxSpeakers: 3,
  /** At most one interruption per this many ms of dialogue (WARN). */
  interruptEveryMs: 40_000,
  /** At most one dramatic pause (≥ 800 ms) per this many ms (WARN). */
  pauseEveryMs: 30_000,
  dramaticPauseMs: 800,
});
