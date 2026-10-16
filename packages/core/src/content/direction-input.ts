import {
  type ExplainerNicheContext,
  readExplainerContext,
} from "../explainer/explainer-context.js";
import { type SceneDirectorInput, STICK_V1_CATALOG } from "../explainer/scene-director.js";
import { resolveNarrationVoice, voiceMatchesLanguage } from "../explainer/voice.js";
import type { Niche } from "../niches/niche.js";
import type { ContentScript } from "./editorial.js";

export type DirectionInput =
  | Readonly<{
      ok: true;
      context: ExplainerNicheContext;
      voiceId: string;
      input: SceneDirectorInput;
    }>
  | Readonly<{ ok: false; reason: "niche_kind_mismatch" | "voice_invalid" }>;

/**
 * The director input every direct_scenes path builds for a script (in-process handler, home
 * worker task, production benchmark export), so a benchmark reproduces what production sends.
 * The caller checks that the script is approved.
 */
export const directionInputFor = (
  script: ContentScript,
  niche: Pick<Niche, "kind" | "context"> | null,
): DirectionInput => {
  const context = niche ? readExplainerContext(niche) : null;
  if (!context) return { ok: false, reason: "niche_kind_mismatch" };
  const voice = resolveNarrationVoice({
    explicit: undefined,
    characters: context.characters,
    nicheVoiceId: context.voiceId,
  });
  if (!voice.ok || !voiceMatchesLanguage(voice.voiceId, script.language))
    return { ok: false, reason: "voice_invalid" };
  return {
    ok: true,
    context,
    voiceId: voice.voiceId,
    input: {
      script,
      persona: context.characters,
      catalog: STICK_V1_CATALOG,
      timing: [],
      // A director draft carries no pinned plate asset (createStoryboard would need it listed);
      // the scene keeps its procedural fallback until the operator swaps a plate in.
      locations: (context.locations ?? []).map((location) => ({
        ...location,
        plate: { overscan: location.plate.overscan },
      })),
    },
  };
};
