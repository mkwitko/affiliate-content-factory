import { describe, expect, it } from "vitest";
import { characterErrorRate, normalizeForErrorRate, wordErrorRate } from "./text-metrics.js";

describe("speech error rates", () => {
  it("treats digits, accents and punctuation like their spoken words", () => {
    expect(normalizeForErrorRate("Bateria de 10.000 mAh, por R$ 48,99!")).toBe(
      "bateria de dez mil miliamperes hora por quarenta e oito com noventa e nove",
    );
    expect(
      wordErrorRate(
        "Bateria de 10.000 mAh, por R$ 48,99.",
        "Bateria de dez mil miliamperes-hora por quarenta e oito com noventa e nove",
      ),
    ).toBe(0);
  });

  it("counts substitutions, insertions and deletions", () => {
    expect(wordErrorRate("a carla achou a estante", "a carla achou estante nova")).toBeCloseTo(
      2 / 5,
      5,
    );
    expect(characterErrorRate("abc", "abd")).toBeCloseTo(1 / 3, 5);
    expect(characterErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "ruido")).toBe(1);
  });
});
