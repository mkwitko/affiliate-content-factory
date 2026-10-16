import { describe, expect, it } from "vitest";
import type { SpeechSynthesizer, SpokenWord } from "./speech-synthesizer.js";
import {
  collapseSpokenWords,
  createSpokenTextSynthesizer,
  expandSpokenPtBr,
  numberToWordsPtBr,
} from "./spoken-text.js";

describe("numberToWordsPtBr", () => {
  it.each([
    [0, "zero"],
    [1, "um"],
    [16, "dezesseis"],
    [21, "vinte e um"],
    [100, "cem"],
    [101, "cento e um"],
    [200, "duzentos"],
    [329, "trezentos e vinte e nove"],
    [1000, "mil"],
    [1500, "mil e quinhentos"],
    [1299, "mil duzentos e noventa e nove"],
    [2000, "dois mil"],
    [100000, "cem mil"],
    [1000000, "um milhão"],
    [2500000, "dois milhões e quinhentos mil"],
  ])("%d -> %s", (n, words) => {
    expect(numberToWordsPtBr(n)).toBe(words);
  });

  it("uses the feminine form when asked", () => {
    expect(numberToWordsPtBr(2, "f")).toBe("duas");
    expect(numberToWordsPtBr(21, "f")).toBe("vinte e uma");
    expect(numberToWordsPtBr(200, "f")).toBe("duzentas");
  });
});

describe("expandSpokenPtBr", () => {
  it.each([
    ["R$ 329,90", "trezentos e vinte e nove com noventa"],
    ["R$329,90", "trezentos e vinte e nove com noventa"],
    ["R$ 35,87", "trinta e cinco com oitenta e sete"],
    ["R$ 1.299,90", "mil duzentos e noventa e nove com noventa"],
    ["R$ 1.299,00", "mil duzentos e noventa e nove reais"],
    ["R$ 1,00", "um real"],
    ["R$ 0,50", "cinquenta centavos"],
    ["R$ 79", "setenta e nove reais"],
    ["87%", "oitenta e sete por cento"],
    ["1.500 watts", "mil e quinhentos watts"],
    ["6,7 polegadas", "seis vírgula sete polegadas"],
    ["250 ml", "duzentos e cinquenta mililitros"],
    ["1 ml", "um mililitro"],
    ["500ml", "quinhentos mililitros"],
    ["3 kg", "três quilos"],
    ["2,5 m", "dois vírgula cinco metros"],
    ["2 h", "duas horas"],
    ["23h59", "vinte e três e cinquenta e nove"],
    ["57 horas", "cinquenta e sete horas"],
    ["5 litros", "cinco litros"],
    ["2 marcas", "duas marcas"],
    ["JBL Tune 520BT", "JBL Tune 520BT"],
    ["Wi-Fi", "Wi-Fi"],
  ])("%s -> %s", (text, spoken) => {
    expect(expandSpokenPtBr(text).spoken).toBe(spoken);
  });

  it("keeps punctuation on the last spoken word and maps groups back to display text", () => {
    const { spoken, groups } = expandSpokenPtBr("Custa R$ 129,90, com 30% off.");
    expect(spoken).toBe("Custa cento e vinte e nove com noventa, com trinta por cento off.");
    expect(groups.map((g) => [g.display, g.spokenWordCount])).toEqual([
      ["Custa", 1],
      ["R$ 129,90,", 7],
      ["com", 1],
      ["30%", 3],
      ["off.", 1],
    ]);
  });

  it("leaves text without numbers untouched", () => {
    const text = "Toca no link da bio e me conta o que achou.";
    expect(expandSpokenPtBr(text).spoken).toBe(text);
  });
});

const word = (text: string, startMs: number, endMs: number): SpokenWord => ({
  text,
  startMs,
  endMs,
});

describe("collapseSpokenWords", () => {
  it("merges spoken words back into display tokens", () => {
    const { groups } = expandSpokenPtBr("Por R$ 79,00 hoje");
    const words = [
      word("Por", 0, 100),
      word("setenta", 100, 300),
      word("e", 300, 350),
      word("nove", 350, 500),
      word("reais", 500, 700),
      word("hoje", 700, 900),
    ];
    expect(collapseSpokenWords(words, groups)).toEqual([
      word("Por", 0, 100),
      word("R$ 79,00", 100, 700),
      word("hoje", 700, 900),
    ]);
  });

  it("returns null when the synthesizer returned a different word count", () => {
    const { groups } = expandSpokenPtBr("Por R$ 79,00 hoje");
    expect(collapseSpokenWords([word("Por", 0, 100)], groups)).toBeNull();
  });
});

describe("createSpokenTextSynthesizer", () => {
  it("keeps the inner synthesizer's cached flag", async () => {
    const inner: SpeechSynthesizer = {
      synthesize: async () => ({
        bytes: new Uint8Array([1]),
        mimeType: "audio/wav",
        durationMs: 500,
        words: [
          { text: "cinco", startMs: 0, endMs: 250 },
          { text: "reais", startMs: 250, endMs: 500 },
        ],
        cached: true,
      }),
    };
    const result = await createSpokenTextSynthesizer(inner).synthesize({
      text: "R$ 5",
      voiceId: "pf_dora",
      language: "pt-BR",
    });
    expect(result.cached).toBe(true);
  });

  const fake = (words: readonly SpokenWord[]): SpeechSynthesizer & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      async synthesize(input) {
        calls.push(input.text);
        return { bytes: new Uint8Array([1]), mimeType: "audio/wav", durationMs: 900, words };
      },
    };
  };

  it("sends the spoken form to the inner synthesizer and returns display words", async () => {
    const inner = fake([
      word("Por", 0, 100),
      word("setenta", 100, 300),
      word("e", 300, 350),
      word("nove", 350, 500),
      word("reais", 500, 700),
      word("hoje", 700, 900),
    ]);
    const result = await createSpokenTextSynthesizer(inner).synthesize({
      text: "Por R$ 79,00 hoje",
      voiceId: "pf_dora",
      language: "pt-BR",
    });
    expect(inner.calls).toEqual(["Por setenta e nove reais hoje"]);
    expect(result.words.map((w) => w.text)).toEqual(["Por", "R$ 79,00", "hoje"]);
    expect(result.durationMs).toBe(900);
  });

  it("falls back to the raw words when the count does not line up", async () => {
    const inner = fake([word("Por", 0, 100), word("setenta", 100, 900)]);
    const result = await createSpokenTextSynthesizer(inner).synthesize({
      text: "Por R$ 79,00 hoje",
      voiceId: "pf_dora",
      language: "pt-BR",
    });
    expect(result.words.map((w) => w.text)).toEqual(["Por", "setenta"]);
  });

  it("passes other languages through unchanged", async () => {
    const inner = fake([]);
    await createSpokenTextSynthesizer(inner).synthesize({
      text: "Only $12.90 today",
      voiceId: "ef_dora",
      language: "es",
    });
    expect(inner.calls).toEqual(["Only $12.90 today"]);
  });
});

describe("expandSpokenPtBr product corpus (content-generation E2)", () => {
  const spoken = (text: string) => expandSpokenPtBr(text).spoken;
  it("reads storage, voltage, frequency, resolution and versions", () => {
    expect(spoken("1 TB")).toBe("um terabyte");
    expect(spoken("128 GB")).toBe("cento e vinte e oito gigabytes");
    expect(spoken("1 GB")).toBe("um gigabyte");
    expect(spoken("220 V")).toBe("duzentos e vinte volts");
    expect(spoken("127V")).toBe("cento e vinte e sete volts");
    expect(spoken("60 Hz")).toBe("sessenta hertz");
    expect(spoken("TV 4K")).toBe("TV quatro K");
    expect(spoken("Bluetooth 5.3")).toBe("Bluetooth cinco ponto três");
    expect(spoken("USB 3.2")).toBe("USB três ponto dois");
  });

  it("keeps thousands groups as numbers, not versions", () => {
    expect(spoken("10.000 mAh")).toBe("dez mil miliampères-hora");
    expect(spoken("R$ 1.299")).toBe("mil duzentos e noventa e nove reais");
  });
});

describe("price spoken form (owner 2026-10-07)", () => {
  it("reads a price drop the way people say it", () => {
    expect(expandSpokenPtBr("De R$ 35,87 por R$ 31,27.").spoken).toBe(
      "De trinta e cinco com oitenta e sete por trinta e um com vinte e sete.",
    );
  });
});
