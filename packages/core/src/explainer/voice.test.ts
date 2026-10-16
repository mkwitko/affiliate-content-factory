import { describe, expect, it } from "vitest";
import { type ExplainerCharacter, readExplainerContext } from "./explainer-context.js";
import { characterVoiceId, resolveNarrationVoice, voiceMatchesLanguage } from "./voice.js";

const character = (
  key: string,
  role: ExplainerCharacter["role"],
  voiceId?: string,
): ExplainerCharacter => ({
  key,
  name: key,
  role,
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
  ...(voiceId ? { voiceId } : {}),
});

describe("resolveNarrationVoice", () => {
  const cast = [character("bia", "secondary", "pf_dora"), character("alex", "main", "pm_alex")];

  it("prefers the explicit voice, then the main character's, then the niche's", () => {
    expect(
      resolveNarrationVoice({ explicit: "pm_santa", characters: cast, nicheVoiceId: "pf_dora" }),
    ).toEqual({ ok: true, voiceId: "pm_santa" });
    expect(resolveNarrationVoice({ characters: cast, nicheVoiceId: "pf_dora" })).toEqual({
      ok: true,
      voiceId: "pm_alex",
    });
    expect(
      resolveNarrationVoice({ characters: [character("alex", "main")], nicheVoiceId: "pf_dora" }),
    ).toEqual({ ok: true, voiceId: "pf_dora" });
  });

  it("does not borrow a secondary character's voice for the narration", () => {
    expect(
      resolveNarrationVoice({ characters: [character("bia", "secondary", "pf_dora")] }),
    ).toEqual({ ok: false, reason: "voice_required" });
  });
});

describe("voiceMatchesLanguage", () => {
  it("pairs Kokoro voice prefixes with the script language", () => {
    expect(voiceMatchesLanguage("pf_dora", "pt-BR")).toBe(true);
    expect(voiceMatchesLanguage("af_heart", "pt-BR")).toBe(false);
    expect(voiceMatchesLanguage("am_adam", "en-US")).toBe(true);
    expect(voiceMatchesLanguage("bf_emma", "en")).toBe(true);
    expect(voiceMatchesLanguage("pf_dora", "en-US")).toBe(false);
  });

  it("does not reject a language it has no mapping for", () => {
    expect(voiceMatchesLanguage("ef_dora", "es")).toBe(true);
  });
});

describe("narrator different from the main character", () => {
  const explainer = readExplainerContext({
    kind: "media",
    context: {
      voiceId: "af_heart",
      characters: [
        {
          key: "sam",
          name: "Sam",
          role: "main",
          rigId: "stick-v1",
          rigVersion: 1,
          palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
          bible: {
            version: 1,
            role: "lead",
            body: { archetype: "average", head: "circle" },
            voice: { voiceId: "am_michael" },
          },
        },
      ],
    },
  });

  it("narrates with the niche voice while Sam speaks dialogue with his bible voice", () => {
    expect(explainer?.characters[0]?.voiceId).toBeUndefined();
    expect(
      resolveNarrationVoice({
        characters: explainer?.characters ?? [],
        nicheVoiceId: explainer?.voiceId,
      }),
    ).toEqual({ ok: true, voiceId: "af_heart" });
    expect(characterVoiceId(explainer?.characters[0], "af_heart")).toBe("am_michael");
    expect(characterVoiceId(undefined, "af_heart")).toBe("af_heart");
  });
});
