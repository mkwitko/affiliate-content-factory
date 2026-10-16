import { describe, expect, it } from "vitest";
import type { Claim, ScriptBeat } from "../content/editorial.js";
import {
  estimateNarrationSeconds,
  hasGenericExplainerOpener,
  validateExplainerScript,
} from "./script-guards.js";

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const fact: Claim = {
  text: "f",
  kind: "verified_fact",
  evidence: [{ kind: "research_observation", observationId: "o" }],
};
const beats: readonly ScriptBeat[] = [
  { kind: "hook", atChar: 0, label: "curiosity_gap" },
  { kind: "payoff", atChar: 10 },
];
const target = { min: 20, max: 60 };
const body = `Your bank ${words(100)}`;

describe("script guards", () => {
  it("estimates seconds from words per minute per language", () => {
    expect(estimateNarrationSeconds(words(165), "en-US")).toBe(60);
    expect(estimateNarrationSeconds(words(155), "pt-BR")).toBe(60);
    expect(estimateNarrationSeconds(words(160), "es")).toBe(60);
  });

  it("detects generic openers per language, ignoring accents and case", () => {
    expect(hasGenericExplainerOpener("Did you know that banks...", "en")).toBe(true);
    expect(hasGenericExplainerOpener("In this video we cover", "en-US")).toBe(true);
    expect(hasGenericExplainerOpener("Você sabia que os bancos...", "pt-BR")).toBe(true);
    expect(hasGenericExplainerOpener("Your bank doesn't keep your money.", "en")).toBe(false);
  });

  it("accepts a valid short and returns its hook type", () => {
    const result = validateExplainerScript({
      body,
      language: "en",
      claims: [fact],
      beats,
      targetSeconds: target,
    });
    expect(result).toEqual({ ok: true, estimatedSeconds: 37, hookType: "curiosity_gap" });
  });

  it("rejects a script with no verified fact", () => {
    const result = validateExplainerScript({
      body,
      language: "en",
      claims: [{ text: "like a bucket", kind: "analogy", evidence: [] }],
      beats,
      targetSeconds: target,
    });
    expect(!result.ok && result.reason).toBe("no_verified_fact");
  });

  it("rejects a hook beat without a known hook type label", () => {
    const result = validateExplainerScript({
      body,
      language: "en",
      claims: [fact],
      beats: [
        { kind: "hook", atChar: 0, label: "viral" },
        { kind: "payoff", atChar: 10 },
      ],
      targetSeconds: target,
    });
    expect(!result.ok && result.reason).toBe("hook_type_missing");
  });

  it("rejects a hook that starts after the opening", () => {
    const result = validateExplainerScript({
      body,
      language: "en",
      claims: [fact],
      beats: [
        { kind: "hook", atChar: 200, label: "what_if" },
        { kind: "payoff", atChar: 10 },
      ],
      targetSeconds: target,
    });
    expect(!result.ok && result.reason).toBe("hook_beat_missing");
  });

  it("rejects a missing payoff", () => {
    const result = validateExplainerScript({
      body,
      language: "en",
      claims: [fact],
      beats: [beats[0] as ScriptBeat],
      targetSeconds: target,
    });
    expect(!result.ok && result.reason).toBe("payoff_beat_missing");
  });

  it("rejects too short and too long bodies", () => {
    const short = validateExplainerScript({
      body: words(20),
      language: "en",
      claims: [fact],
      beats,
      targetSeconds: target,
    });
    const long = validateExplainerScript({
      body: words(400),
      language: "en",
      claims: [fact],
      beats,
      targetSeconds: target,
    });
    expect([!short.ok && short.reason, !long.ok && long.reason]).toEqual(["too_short", "too_long"]);
  });

  it("rejects a generic opener before anything else", () => {
    const result = validateExplainerScript({
      body: `Did you know ${words(100)}`,
      language: "en",
      claims: [fact],
      beats,
      targetSeconds: target,
    });
    expect(!result.ok && result.reason).toBe("generic_opener");
  });
});
