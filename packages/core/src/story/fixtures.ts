import {
  buildEpisodePlan,
  type ContinuityFact,
  type EpisodeSpec,
  type StoryIdea,
} from "./story.js";

export const fixtureIdea = (over: Partial<StoryIdea> = {}): StoryIdea => ({
  id: "idea-1",
  logline: "Why the milk is always at the back of the store",
  template: "problem_solution",
  theme: "store layout",
  castIds: ["alex"],
  locationId: "supermarket",
  want: "Buy one carton of milk",
  obstacle: "The store is laid out to make shoppers wander",
  twist: "The layout is the product",
  durationClass: "short",
  seed: 1,
  ...over,
});

const plan = (
  id: string,
  idea: Partial<StoryIdea>,
  hook: string,
  contentIntent: EpisodeSpec["contentIntent"],
  seriesId = "series-1",
) =>
  buildEpisodePlan({
    id,
    seriesId,
    idea: fixtureIdea(idea),
    hook,
    targetSec: 60,
    targetAudience: "general",
    contentIntent,
  });

const dialogue = (spec: EpisodeSpec): EpisodeSpec => ({
  ...spec,
  beats: spec.beats.map((b, i) =>
    b.kind === "hook"
      ? b
      : {
          ...b,
          dialogue: [
            { characterId: b.characterIds[i % b.characterIds.length] ?? "", text: b.outcome },
          ],
        },
  ),
});

export const recurringIdeas = [
  fixtureIdea({
    id: "r1",
    template: "mistake_consequence",
    logline: "Rafa lends Bia the shop key",
    castIds: ["carla", "bia", "rafa"],
    locationId: "corner-shop",
    want: "Keep the shop open on time",
    obstacle: "The key is missing",
    twist: "Bia copied it",
    durationClass: "mid",
    seed: 11,
  }),
  fixtureIdea({
    id: "r2",
    template: "misunderstanding",
    logline: "Carla thinks Rafa sold the shop",
    castIds: ["carla", "bia", "rafa"],
    locationId: "corner-shop",
    want: "Learn the truth about the sign",
    obstacle: "Nobody answers straight",
    twist: "The sign is for a new shelf",
    durationClass: "mid",
    seed: 12,
  }),
  fixtureIdea({
    id: "r3",
    template: "discovery",
    logline: "Bia finds the copied key again",
    castIds: ["carla", "bia", "rafa"],
    locationId: "back-room",
    want: "Decide who keeps the key",
    obstacle: "Both want it",
    durationClass: "mid",
    seed: 13,
  }),
] as const;

/** The five shapes required by spec 13. */
export const STORY_FIXTURES = {
  explainer: plan("fx-explainer", {}, "Why is the milk always at the back?", "explainer"),
  singleProtagonist: plan(
    "fx-single",
    {
      template: "transformation",
      castIds: ["alex"],
      locationId: "gym",
      want: "Finish one push-up",
      obstacle: "Zero strength",
      twist: "Day 30 arrives",
    },
    "Alex cannot do one push-up",
    "story",
  ),
  twoCharacterDialogue: dialogue(
    plan(
      "fx-two",
      {
        template: "misunderstanding",
        castIds: ["carla", "bia"],
        locationId: "kitchen",
        want: "Agree on dinner",
        obstacle: "Each hears a different plan",
      },
      "Dinner is at eight. Or nine?",
      "comedy",
    ),
  ),
  threeCharacter: plan(
    "fx-three",
    {
      template: "competition",
      castIds: ["carla", "bia", "rafa"],
      locationId: "park",
      want: "Win the paper-plane contest",
      obstacle: "One plane for three",
    },
    "Three friends, one paper plane",
    "story",
  ),
  recurring: plan(
    "fx-recurring",
    recurringIdeas[0],
    "Rafa lends Bia the shop key",
    "story",
    "series-shop",
  ),
} as const satisfies Record<string, EpisodeSpec>;

/** Three consecutive episodes of one series with the same cast (used by continuity tests). */
export const RECURRING_SERIES = recurringIdeas.map((idea, i) =>
  buildEpisodePlan({
    id: `shop-${i + 1}`,
    seriesId: "series-shop",
    idea,
    hook: idea.logline,
    targetSec: 90,
    targetAudience: "general",
    contentIntent: "story",
  }),
);

const f = (
  id: string,
  episodeId: string,
  kind: ContinuityFact["kind"],
  subject: string,
  predicate: string,
  salience: ContinuityFact["salience"],
  rest: Partial<ContinuityFact> = {},
): ContinuityFact => ({ id, episodeId, kind, subject, predicate, salience, ...rest });

/** Facts written by the three RECURRING_SERIES episodes; the key moves from Rafa to Bia. */
export const RECURRING_FACTS: readonly (readonly ContinuityFact[])[] = [
  [
    f("k1", "shop-1", "possession", "rafa", "has", 3, { object: "key" }),
    f("k2", "shop-1", "job", "rafa", "runs the corner shop", 2),
    f("k3", "shop-1", "possession", "bia", "has", 2, { object: "key-copy" }),
  ],
  [
    f("k4", "shop-2", "location", "carla", "is_at", 1, { object: "corner-shop" }),
    f("k5", "shop-2", "conflict", "carla", "suspects the shop was sold", 3, { object: "rafa" }),
  ],
  [
    f("k6", "shop-3", "possession", "bia", "has", 3, { object: "key", supersedes: "k1" }),
    f("k7", "shop-3", "conflict", "carla", "trusts him again", 2, {
      object: "rafa",
      supersedes: "k5",
    }),
    f("k8", "shop-3", "growth", "bia", "learned to ask before copying", 2),
  ],
];
