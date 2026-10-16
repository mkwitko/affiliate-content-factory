import type { ExplainerCharacter } from "./explainer-context.js";

/**
 * The narration voice of a SceneSpec storyboard. Resolved once when the storyboard is created and
 * stored on it (checksum-bound), so every render of it sounds the same, and every episode of the
 * niche reuses the same main-character voice unless the operator names another one.
 */
export const resolveNarrationVoice = (input: {
  explicit?: string | undefined;
  characters: readonly ExplainerCharacter[];
  nicheVoiceId?: string | undefined;
}): Readonly<{ ok: true; voiceId: string } | { ok: false; reason: "voice_required" }> => {
  const voiceId =
    input.explicit?.trim() ||
    input.characters.find((character) => character.role === "main" && character.voiceId)?.voiceId ||
    input.nicheVoiceId;
  return voiceId ? { ok: true, voiceId } : { ok: false, reason: "voice_required" };
};

/**
 * The voice a character speaks dialogue with: its own voiceId, else its bible's voice, else the
 * narration voice. This is how the narrator and the main character can sound different: the
 * narration comes from the niche voice while the character carries its voice in its bible.
 */
export const characterVoiceId = (
  character: Pick<ExplainerCharacter, "voiceId" | "bible"> | undefined,
  narrationVoiceId: string,
): string => character?.voiceId ?? character?.bible?.voice?.voiceId ?? narrationVoiceId;

/**
 * Voice separation (v2 slice 32, WARN): two speakers of one scene need different voices, and
 * voices of the same Kokoro gender class (second letter: f or m) are flagged because pitch
 * separation cannot be checked here (spec asks ≥ 3 semitones or a gender/age contrast).
 */
export const voiceSeparationWarnings = (
  scenes: readonly Readonly<{
    index: number;
    dialogue?: readonly Readonly<{ speakerKey: string }>[] | undefined;
  }>[],
  voiceFor: (speakerKey: string) => string | undefined,
): readonly string[] => {
  const out = new Set<string>();
  for (const scene of scenes) {
    const speakers = [...new Set((scene.dialogue ?? []).map((line) => line.speakerKey))];
    for (let i = 0; i < speakers.length; i += 1)
      for (let j = i + 1; j < speakers.length; j += 1) {
        const a = voiceFor(speakers[i] as string);
        const b = voiceFor(speakers[j] as string);
        if (!a || !b) continue;
        if (a === b) out.add(`voice_shared:${speakers[i]}:${speakers[j]}`);
        else if (a.charAt(1) === b.charAt(1)) out.add(`voice_close:${speakers[i]}:${speakers[j]}`);
      }
  }
  return [...out];
};

/** Kokoro's first letter is the voice's language: p = Brazilian Portuguese, a/b = English. */
const PREFIXES: Readonly<Record<string, readonly string[]>> = { pt: ["p"], en: ["a", "b"] };

export const voiceMatchesLanguage = (voiceId: string, language: string): boolean => {
  const prefixes = PREFIXES[language.toLowerCase().split("-")[0] ?? ""];
  return !prefixes || prefixes.includes(voiceId.charAt(0));
};
