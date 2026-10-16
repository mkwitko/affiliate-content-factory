import { createHash } from "node:crypto";

// Story system (spec 13). Pure data and lints; nothing here publishes or renders.

export type BeatTemplateId =
  | "problem_solution"
  | "mistake_consequence"
  | "secret_reveal"
  | "misunderstanding"
  | "escalation"
  | "discovery"
  | "competition"
  | "transformation"
  | "cause_effect";
export type BeatKind =
  | "hook"
  | "setup"
  | "inciting"
  | "attempt"
  | "complication"
  | "turn"
  | "low"
  | "climax"
  | "resolution"
  | "button";
export type BeatLink = "therefore" | "but";
/** Minimal line shape; slice 32 (dialogue) owns timing and voice. */
export type DialogueLine = Readonly<{ characterId: string; text: string }>;
export type ContinuityFact = Readonly<{
  id: string;
  episodeId: string;
  kind:
    | "relationship"
    | "job"
    | "location"
    | "possession"
    | "knowledge"
    | "event"
    | "gag"
    | "conflict"
    | "growth";
  subject: string;
  predicate: string;
  object?: string;
  salience: 1 | 2 | 3;
  supersedes?: string;
  expiresEpisode?: number;
}>;
export type StoryIdea = Readonly<{
  id: string;
  logline: string;
  template: BeatTemplateId;
  theme: string;
  castIds: readonly string[];
  locationId: string;
  want: string;
  obstacle: string;
  twist?: string;
  durationClass: "short" | "mid" | "long";
  seed: number;
}>;
export type StoryBeat = Readonly<{
  id: string;
  kind: BeatKind;
  link?: BeatLink;
  want: string;
  conflict: string;
  outcome: string;
  characterIds: readonly string[];
  locationId: string;
  zoneId?: string;
  targetSec: number;
  visualEvent: string;
  dialogue?: readonly DialogueLine[];
}>;
/** NoveltyGuard output (spec 21). There is deliberately no BLOCK severity. */
export type NoveltySeverity = "LOG" | "WARN";
export type NoveltySignal = Readonly<{ code: string; severity: NoveltySeverity; detail: string }>;
export type ColorStage = "hook" | "problem" | "explain" | "twist" | "resolve";
export type EpisodeSpec = Readonly<{
  id: string;
  seriesId: string;
  idea: StoryIdea;
  targetSec: number;
  hook: string;
  beats: readonly StoryBeat[];
  plants: readonly Readonly<{ id: string; beatId: string }>[];
  pays: readonly Readonly<{ plantId: string; beatId: string }>[];
  colorScript: readonly ColorStage[];
  factsWritten: readonly ContinuityFact[];
  fingerprint: string;
  targetAudience: "adult" | "teen" | "general";
  contentIntent: "explainer" | "story" | "comedy" | "commerce";
  /** Stored with the episode when a novelty check ran; advisory only. */
  novelty?: readonly NoveltySignal[];
}>;

type Step = readonly [BeatKind, BeatLink?];
/** Planning structures, not formulas: every step after the hook is a therefore or a but. */
export const BEAT_TEMPLATES: Readonly<Record<BeatTemplateId, readonly Step[]>> = {
  problem_solution: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "therefore"],
    ["attempt", "therefore"],
    ["complication", "but"],
    ["climax", "therefore"],
    ["resolution", "therefore"],
    ["button", "therefore"],
  ],
  mistake_consequence: [
    ["hook"],
    ["setup", "therefore"],
    ["attempt", "therefore"],
    ["turn", "but"],
    ["low", "therefore"],
    ["climax", "but"],
    ["resolution", "therefore"],
  ],
  secret_reveal: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "but"],
    ["attempt", "therefore"],
    ["complication", "but"],
    ["turn", "therefore"],
    ["climax", "therefore"],
    ["resolution", "therefore"],
  ],
  misunderstanding: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "but"],
    ["complication", "therefore"],
    ["low", "but"],
    ["turn", "therefore"],
    ["resolution", "therefore"],
  ],
  escalation: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "therefore"],
    ["complication", "but"],
    ["complication", "therefore"],
    ["climax", "but"],
    ["button", "therefore"],
  ],
  discovery: [
    ["hook"],
    ["setup", "therefore"],
    ["attempt", "therefore"],
    ["turn", "but"],
    ["climax", "therefore"],
    ["resolution", "therefore"],
  ],
  competition: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "therefore"],
    ["attempt", "therefore"],
    ["low", "but"],
    ["climax", "therefore"],
    ["resolution", "therefore"],
  ],
  transformation: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "but"],
    ["attempt", "therefore"],
    ["low", "but"],
    ["turn", "therefore"],
    ["resolution", "therefore"],
    ["button", "therefore"],
  ],
  cause_effect: [
    ["hook"],
    ["setup", "therefore"],
    ["inciting", "therefore"],
    ["attempt", "therefore"],
    ["turn", "but"],
    ["climax", "therefore"],
    ["resolution", "therefore"],
  ],
};

const STAGE: Readonly<Record<BeatKind, ColorStage>> = {
  hook: "hook",
  setup: "problem",
  inciting: "problem",
  attempt: "explain",
  complication: "explain",
  turn: "twist",
  low: "twist",
  climax: "resolve",
  resolution: "resolve",
  button: "resolve",
};

const beatText = (kind: BeatKind, idea: StoryIdea) => {
  const twist = idea.twist ?? idea.obstacle;
  const t: Record<BeatKind, readonly [string, string, string, string]> = {
    hook: [
      "Make the viewer stay",
      idea.obstacle,
      idea.logline,
      `Open on the question: ${idea.logline}`,
    ],
    setup: [
      idea.want,
      "Something already stands in the way",
      "The goal and the stakes are clear",
      `Show ${idea.want}`,
    ],
    inciting: [
      idea.want,
      idea.obstacle,
      "The obstacle forces a choice",
      `The obstacle appears: ${idea.obstacle}`,
    ],
    attempt: [idea.want, idea.obstacle, "The first try only partly works", "The first try"],
    complication: [
      idea.want,
      `${idea.obstacle} gets worse`,
      "The plan breaks",
      "The plan visibly breaks",
    ],
    turn: [idea.want, twist, "New information changes the plan", `Reveal: ${twist}`],
    low: [
      idea.want,
      "Everything seems lost",
      "The lowest point",
      "The lowest point, held for a beat",
    ],
    climax: [idea.want, idea.obstacle, "The decisive move is made", "The decisive move"],
    resolution: [idea.want, "The cost of the win", "The want is answered", "The answer, shown"],
    button: ["Leave a smile", "None left", "A last small image", "A last small gag"],
  };
  const [want, conflict, outcome, visualEvent] = t[kind];
  return { want, conflict, outcome, visualEvent };
};

export const episodeHash = (input: {
  template: string;
  kinds: readonly string[];
  castIds: readonly string[];
  locationId: string;
}) =>
  createHash("sha256")
    .update(
      JSON.stringify([input.template, input.kinds, [...input.castIds].sort(), input.locationId]),
    )
    .digest("hex");

/** Expands a template into a lint-clean plan; hook wording is supplied by the author. */
export const buildEpisodePlan = (input: {
  id: string;
  seriesId: string;
  idea: StoryIdea;
  hook: string;
  targetSec: number;
  targetAudience: EpisodeSpec["targetAudience"];
  contentIntent: EpisodeSpec["contentIntent"];
}): EpisodeSpec => {
  const steps = BEAT_TEMPLATES[input.idea.template];
  const each = Math.round((input.targetSec / steps.length) * 10) / 10;
  const beats: StoryBeat[] = steps.map(([kind, link], i) => ({
    id: `${input.id}-b${i + 1}`,
    kind,
    ...(link ? { link } : {}),
    ...beatText(kind, input.idea),
    characterIds: input.idea.castIds,
    locationId: input.idea.locationId,
    targetSec:
      i === steps.length - 1
        ? Math.round((input.targetSec - each * (steps.length - 1)) * 10) / 10
        : each,
  }));
  const setup = beats.find((b) => b.kind === "setup");
  const payoff = beats.find((b) => b.kind === "turn" || b.kind === "climax");
  const planted = input.idea.twist !== undefined && setup && payoff;
  return {
    id: input.id,
    seriesId: input.seriesId,
    idea: input.idea,
    targetSec: input.targetSec,
    hook: input.hook,
    beats,
    plants: planted ? [{ id: `${input.id}-plant-1`, beatId: setup.id }] : [],
    pays: planted ? [{ plantId: `${input.id}-plant-1`, beatId: payoff.id }] : [],
    colorScript: beats.map((b) => STAGE[b.kind]),
    factsWritten: [],
    fingerprint: episodeHash({
      template: input.idea.template,
      kinds: beats.map((b) => b.kind),
      castIds: input.idea.castIds,
      locationId: input.idea.locationId,
    }),
    targetAudience: input.targetAudience,
    contentIntent: input.contentIntent,
  };
};

const AND_THEN = /^\s*(and\s+then|then)\b/i;
/** BLOCK lints for one episode (spec 13). Returns violation codes; empty means clean. */
export const lintEpisode = (spec: EpisodeSpec): readonly string[] => {
  const out: string[] = [];
  if (spec.beats[0]?.kind !== "hook") out.push("first_beat_not_hook");
  const words = spec.hook.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) out.push("hook_missing");
  else if (words > 9) out.push("hook_too_long");
  const index = new Map(spec.beats.map((b, i) => [b.id, i]));
  if (index.size !== spec.beats.length) out.push("beat_ids_not_unique");
  for (const [i, beat] of spec.beats.entries()) {
    if (![beat.want, beat.conflict, beat.outcome].every((s) => s.trim()))
      out.push(`beat_incomplete:${beat.id}`);
    if (i > 0 && !beat.link) out.push(`beat_missing_link:${beat.id}`);
    if (i > 0 && [beat.want, beat.conflict, beat.outcome].some((s) => AND_THEN.test(s)))
      out.push(`beat_and_then:${beat.id}`);
  }
  for (const plant of spec.plants) {
    const at = index.get(plant.beatId);
    if (at === undefined) {
      out.push(`plant_beat_unknown:${plant.id}`);
      continue;
    }
    const pay = spec.pays.find((p) => p.plantId === plant.id);
    if (!pay) {
      if (spec.idea.durationClass === "short") out.push(`plant_unpaid:${plant.id}`);
      continue;
    }
    const payAt = index.get(pay.beatId);
    if (payAt === undefined) out.push(`pay_beat_unknown:${plant.id}`);
    else if (payAt <= at) out.push(`pay_before_plant:${plant.id}`);
  }
  return out;
};

/** Plants outside short episodes may wait at most 3 later episodes; `episodes` is in series order. */
export const lintSeriesPlants = (episodes: readonly EpisodeSpec[]): readonly string[] => {
  const out: string[] = [];
  for (const [i, ep] of episodes.entries()) {
    if (episodes.length <= i + 4) continue;
    const window = episodes.slice(i, i + 4);
    for (const plant of ep.plants)
      if (!window.some((e) => e.pays.some((p) => p.plantId === plant.id)))
        out.push(`plant_overdue:${plant.id}`);
  }
  return out;
};
