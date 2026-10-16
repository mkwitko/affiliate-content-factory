import { describe, expect, it } from "vitest";
import { compareNarration, scriptNumbers } from "./narration-check.js";

const meta = { model: "local:parakeet-tdt-0.6b-v3", now: new Date("2026-10-08T12:00:00Z") };

describe("compareNarration", () => {
  const lines = ["Olha esse achado por R$ 329,90.", "São 15% de desconto, 2 unidades."];

  it("extracts prices, percents and numbers as written", () => {
    expect(scriptNumbers(lines)).toEqual(["R$ 329,90", "15%", "2"]);
  });

  it("passes when the numbers are heard as digits", () => {
    const check = compareNarration(
      lines,
      "Olha esse achado por R$ 329,90. São 15% de desconto, 2 unidades.",
      meta,
    );
    expect(check.verdict).toBe("pass");
    expect(check.missing).toEqual([]);
    expect(check.wer).toBe(0);
  });

  it("passes when the numbers are spelled out", () => {
    const check = compareNarration(
      lines,
      "Olha esse achado por trezentos e vinte e nove reais e noventa centavos. São quinze por cento de desconto, duas unidades.",
      meta,
    );
    expect(check.verdict).toBe("pass");
  });

  it("blocks a wrong spoken price", () => {
    const check = compareNarration(
      lines,
      "Olha esse achado por R$ 339,90. São 15% de desconto, 2 unidades.",
      meta,
    );
    expect(check.verdict).toBe("block");
    expect(check.missing).toEqual(["R$ 329,90"]);
    expect(check.wer).toBeGreaterThan(0);
  });

  it("blocks a dropped percent", () => {
    const check = compareNarration(lines, "Olha esse achado por R$ 329,90. 2 unidades.", meta);
    expect(check.missing).toEqual(["15%"]);
  });

  it("does not match a number inside a longer one", () => {
    expect(compareNarration(["Só 5 sobraram."], "Só 15 sobraram.", meta).verdict).toBe("block");
  });
});
