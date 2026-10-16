import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import {
  type ClaimInput,
  createContentScript,
  type ScriptBeat,
} from "../../../content/editorial.js";
import { readExplainerContext } from "../../explainer-context.js";
import type { PropId } from "../../props.js";
import type { PoseId } from "../../rigs/stick-v1.js";
import { type SceneDirectorInput, STICK_V1_CATALOG } from "../../scene-director.js";
import type { ActorActionType } from "../../scene-spec.js";

/** Spec 5.7.4: the ten situation classes every split covers. */
export const SITUATION_CLASSES = [
  "problem_presentation",
  "walk_to_object",
  "point_at_number",
  "two_actors",
  "price_in_reais",
  "percentages",
  "many_props",
  "unsupported_action",
  "ambiguous_script",
  "long_script",
] as const;
export type SituationClass = (typeof SITUATION_CLASSES)[number];

/**
 * One director fixture. `expected.validator` is the outcome a correct director reaches (every
 * gate passes); the require* fields name what those scenes must contain. `source` is
 * "synthetic" or "production:<scriptId>"; only production scripts count for spec 5.7.5.
 * `class` labels the synthetic coverage matrix; exported production scripts carry none. A
 * production fixture carries its niche's `characters` and `locations` (as the director saw
 * them), which replace the file's characters.
 */
export type SceneDirectorFixture = Readonly<{
  id: string;
  class?: SituationClass;
  case: "approved" | "problematic" | "adversarial";
  source: string;
  language: string;
  body: string;
  claims: readonly ClaimInput[];
  beats: readonly ScriptBeat[];
  cast: readonly string[];
  expected: Readonly<{
    validator: "pass";
    requireActions?: readonly ActorActionType[];
    requirePoses?: readonly PoseId[];
    requireProps?: readonly PropId[];
    minActorsInOneScene?: number;
  }>;
  note?: string;
  characters?: readonly unknown[];
  locations?: readonly unknown[];
}>;
export type SceneDirectorFixtureFile = Readonly<{
  split: "tuning" | "holdout";
  characters: readonly unknown[];
  fixtures: readonly SceneDirectorFixture[];
}>;

const WORKSPACE = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const ACTOR = parseUserId("22222222-2222-4222-8222-222222222222");

/** Builds the director input for a fixture: an approved script and the fixture's cast. */
export const fixtureInput = (
  file: SceneDirectorFixtureFile,
  fixture: SceneDirectorFixture,
): SceneDirectorInput => {
  const context = readExplainerContext({
    kind: "media",
    context: {
      characters: fixture.characters ?? file.characters,
      explainer: { locations: fixture.locations },
    },
  });
  const characters = context?.characters ?? [];
  const script = createContentScript({
    id: fixture.id,
    workspaceId: WORKSPACE,
    contentItemId: `fixture-${fixture.id}`,
    version: 1,
    body: fixture.body,
    language: fixture.language,
    claims: fixture.claims,
    beats: fixture.beats,
    actorId: ACTOR,
  });
  return {
    script: { ...script, status: "approved" },
    persona: characters.filter((character) => fixture.cast.includes(character.key)),
    catalog: STICK_V1_CATALOG,
    timing: [],
    ...(context?.locations ? { locations: context.locations } : {}),
  };
};
