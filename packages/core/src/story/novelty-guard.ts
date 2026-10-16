import { createHash } from "node:crypto";
import type { EpisodeSpec, NoveltySeverity, NoveltySignal } from "./story.js";

export type { NoveltySeverity, NoveltySignal };

// NoveltyGuard (spec 21). Pure functions. It only ever LOGs or WARNs: the severity type has no
// BLOCK, so a caller cannot gate publishing on it by accident. Objective platform rules (no
// invented numbers, verified facts) are enforced elsewhere and stay BLOCK there.

/**
 * HYPOTHESIS: every number and severity below is the spec's starting point, not calibrated on
 * real episodes. Recalibrate after the first 10 published episodes of a series (see the slice 33
 * note in the plan), then decide per signal whether it deserves more than WARN.
 */
export const NOVELTY_TUNABLES = {
  templateCooldown: { window: 3, severity: "WARN" },
  focalDuoConsecutive: { severity: "WARN" },
  placeCooldown: { window: 5, severity: "LOG" },
  hookFormCooldown: { window: 2, severity: "WARN" },
  endingFormCooldown: { window: 3, severity: "LOG" },
  beatSequenceDistance: { min: 3, window: 3, severity: "WARN" },
  ngramOverlap: { n: 5, max: 0.2, severity: "WARN" },
  dialogueJaccard: { n: 4, max: 0.15, severity: "WARN" },
  cameraPatternRepeat: { window: 3, severity: "LOG" },
  brandTimeShare: { max: 0.15, severity: "WARN" },
  emptySourcedFactSlot: { severity: "WARN" },
} as const satisfies Record<string, { severity: NoveltySeverity; [key: string]: unknown }>;

/** One episode plus the optional facts only the script, storyboard and brand layer know. */
export type EpisodeRecord = Readonly<{
  spec: EpisodeSpec;
  scriptBody?: string;
  /** One entry per scene, e.g. "medium:push_in"; compared as a whole sequence. */
  cameraPattern?: readonly string[];
  /** Seconds of fixed brand material (intro, outro, sponsor card). */
  brandSec?: number;
  /** Number of sourced facts in the script; 0 on an explainer leaves the slot empty. */
  sourcedFactCount?: number;
}>;

export type NoveltyFingerprint = Readonly<{
  template: string;
  beatKindHash: string;
  cast: readonly string[];
  places: readonly string[];
  hookForm: string;
  endingForm: string;
  topic: string;
}>;

export const hookForm = (hook: string): string => {
  const h = hook.trim();
  if (/\?$/.test(h)) return "question";
  if (/\d/.test(h)) return "number";
  if (/^["'“‘]/.test(h)) return "quote";
  return "statement";
};

export const noveltyFingerprint = (spec: EpisodeSpec): NoveltyFingerprint => ({
  template: spec.idea.template,
  beatKindHash: createHash("sha256")
    .update(spec.beats.map((b) => b.kind).join(">"))
    .digest("hex")
    .slice(0, 16),
  cast: [...spec.idea.castIds].sort(),
  places: [...new Set(spec.beats.map((b) => `${b.locationId}/${b.zoneId ?? "-"}`))].sort(),
  hookForm: hookForm(spec.hook),
  endingForm: spec.beats.at(-1)?.kind ?? "none",
  topic: spec.idea.theme.trim().toLowerCase(),
});

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
const ngrams = (text: string, n: number) => {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
};
/** Share of `a`'s n-grams that also appear in `b`. */
const overlap = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / a.size;
};
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
};
const editDistance = (a: readonly string[], b: readonly string[]) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length] ?? 0;
};
const dialogueText = (spec: EpisodeSpec) =>
  spec.beats.flatMap((b) => b.dialogue?.map((l) => l.text) ?? []).join(" ");

/** Compares `current` with `recent` (oldest first, the series' last published episodes). */
export const noveltySignals = (
  current: EpisodeRecord,
  recent: readonly EpisodeRecord[],
): readonly NoveltySignal[] => {
  const t = NOVELTY_TUNABLES;
  const out: NoveltySignal[] = [];
  const add = (code: string, severity: NoveltySeverity, detail: string) =>
    out.push({ code, severity, detail });
  const last = (n: number) => recent.slice(-n);
  const fp = noveltyFingerprint(current.spec);
  const fps = (n: number) => last(n).map((r) => noveltyFingerprint(r.spec));

  if (fps(t.templateCooldown.window).some((f) => f.template === fp.template))
    add(
      "template_cooldown",
      t.templateCooldown.severity,
      `template ${fp.template} used in the last ${t.templateCooldown.window} episodes`,
    );

  const duo = (spec: EpisodeSpec) => spec.idea.castIds.slice(0, 2).sort().join("+");
  const previous = recent.at(-1);
  if (
    previous &&
    current.spec.idea.castIds.length >= 2 &&
    previous.spec.idea.castIds.length >= 2 &&
    duo(previous.spec) === duo(current.spec)
  )
    add(
      "focal_duo_consecutive",
      t.focalDuoConsecutive.severity,
      `${duo(current.spec)} lead two episodes in a row`,
    );

  const seenPlaces = new Set(fps(t.placeCooldown.window).flatMap((f) => f.places));
  const repeatedPlaces = fp.places.filter((p) => seenPlaces.has(p));
  if (repeatedPlaces.length)
    add(
      "place_cooldown",
      t.placeCooldown.severity,
      `places seen in the last ${t.placeCooldown.window} episodes: ${repeatedPlaces.join(", ")}`,
    );

  if (fps(t.hookFormCooldown.window).some((f) => f.hookForm === fp.hookForm))
    add(
      "hook_form_cooldown",
      t.hookFormCooldown.severity,
      `hook form ${fp.hookForm} used in the last ${t.hookFormCooldown.window} episodes`,
    );
  if (fps(t.endingFormCooldown.window).some((f) => f.endingForm === fp.endingForm))
    add(
      "ending_form_cooldown",
      t.endingFormCooldown.severity,
      `ending ${fp.endingForm} used in the last ${t.endingFormCooldown.window} episodes`,
    );

  const kinds = current.spec.beats.map((b) => b.kind);
  const close = last(t.beatSequenceDistance.window).filter(
    (r) =>
      editDistance(
        kinds,
        r.spec.beats.map((b) => b.kind),
      ) < t.beatSequenceDistance.min,
  );
  if (close.length)
    add(
      "beat_sequence_similar",
      t.beatSequenceDistance.severity,
      `beat sequence within edit distance ${t.beatSequenceDistance.min - 1} of ${close.length} recent episode(s)`,
    );

  if (current.scriptBody) {
    const mine = ngrams(current.scriptBody, t.ngramOverlap.n);
    const worst = Math.max(
      0,
      ...recent.flatMap((r) =>
        r.scriptBody ? [overlap(mine, ngrams(r.scriptBody, t.ngramOverlap.n))] : [],
      ),
    );
    if (worst > t.ngramOverlap.max)
      add(
        "script_overlap",
        t.ngramOverlap.severity,
        `${Math.round(worst * 100)}% of ${t.ngramOverlap.n}-grams repeat an earlier script`,
      );
  }

  const myDialogue = ngrams(dialogueText(current.spec), t.dialogueJaccard.n);
  const worstDialogue = Math.max(
    0,
    ...recent.map((r) => jaccard(myDialogue, ngrams(dialogueText(r.spec), t.dialogueJaccard.n))),
  );
  if (worstDialogue > t.dialogueJaccard.max)
    add(
      "dialogue_overlap",
      t.dialogueJaccard.severity,
      `dialogue ${t.dialogueJaccard.n}-gram Jaccard ${worstDialogue.toFixed(2)} against an earlier episode`,
    );

  const pattern = current.cameraPattern?.join("|");
  const priorPatterns = last(t.cameraPatternRepeat.window).map((r) => r.cameraPattern?.join("|"));
  if (
    pattern &&
    priorPatterns.length === t.cameraPatternRepeat.window &&
    priorPatterns.every((p) => p === pattern)
  )
    add(
      "camera_pattern_repeat",
      t.cameraPatternRepeat.severity,
      `camera/layout pattern identical to the previous ${t.cameraPatternRepeat.window} episodes`,
    );

  if (
    current.brandSec !== undefined &&
    current.spec.targetSec > 0 &&
    current.brandSec / current.spec.targetSec > t.brandTimeShare.max
  )
    add(
      "brand_time_share",
      t.brandTimeShare.severity,
      `${Math.round((current.brandSec / current.spec.targetSec) * 100)}% of the runtime is fixed brand material`,
    );

  if (current.sourcedFactCount === 0 && current.spec.contentIntent === "explainer")
    add(
      "empty_sourced_fact_slot",
      t.emptySourcedFactSlot.severity,
      "explainer has no sourced fact",
    );

  return out;
};

/** Signals for each of the last `count` episodes of a series, each against the ones before it. */
export const seriesNovelty = (
  episodes: readonly EpisodeRecord[],
  count = 10,
): readonly Readonly<{ episodeId: string; signals: readonly NoveltySignal[] }>[] =>
  episodes.slice(-count).map((record) => {
    const at = episodes.indexOf(record);
    return { episodeId: record.spec.id, signals: noveltySignals(record, episodes.slice(0, at)) };
  });
