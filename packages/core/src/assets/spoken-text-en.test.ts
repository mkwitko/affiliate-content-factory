import { describe, expect, it } from "vitest";
import type { SpeechSynthesizer, SpokenWord } from "./speech-synthesizer.js";
import { createSpokenTextSynthesizer } from "./spoken-text.js";
import { expandSpokenEn, numberToWordsEn } from "./spoken-text-en.js";

describe("numberToWordsEn", () => {
  it.each([
    [0, "zero"],
    [20, "twenty"],
    [25, "twenty five"],
    [210, "two hundred ten"],
    [1000, "one thousand"],
    [79_900, "seventy nine thousand nine hundred"],
    [22_000_000, "twenty two million"],
    [2_400_000_000, "two billion four hundred million"],
  ])("%d -> %s", (n, words) => {
    expect(numberToWordsEn(n)).toBe(words);
  });
});

describe("expandSpokenEn", () => {
  it.each([
    ["It costs $9.99 today", "It costs nine ninety nine today"],
    ["Only $1.50 each", "Only one fifty each"],
    ["Only $4.05 each", "Only four oh five each"],
    ["Pay $10.00 now", "Pay ten dollars now"],
    ["Pay $20 now", "Pay twenty dollars now"],
    ["Pay $1 now", "Pay one dollar now"],
    ["Pay $210 now", "Pay two hundred ten dollars now"],
    ["Pay $210.50 now", "Pay two hundred ten dollars and fifty cents now"],
    ["Prices rose 25% last year", "Prices rose twenty five percent last year"],
    ["It rose 24.8 percent", "It rose 24.8 percent"],
    ["It rose 2.5% overall", "It rose two point five percent overall"],
    ["Back in 1999 it was cheap", "Back in nineteen ninety nine it was cheap"],
    ["Since 2014 it doubled", "Since twenty fourteen it doubled"],
    ["In 2005 it fell", "In two thousand five it fell"],
    ["In 1908 it began", "In nineteen oh eight it began"],
    ["From 1999 to 2014 prices rose", "From nineteen ninety nine to twenty fourteen prices rose"],
    ["The 1920s were wild", "The nineteen twenties were wild"],
    ["The 1870s too", "The eighteen seventies too"],
    ["The 2010s changed it", "The twenty tens changed it"],
    ["The 1900s ended", "The nineteen hundreds ended"],
    ["About 1,000 units", "About one thousand units"],
    ["About 79,900 units", "About seventy nine thousand nine hundred units"],
    ["About 1500 units", "About one thousand five hundred units"],
    ["Roughly 22 million people", "Roughly twenty two million people"],
    ["A $10 million fund", "A ten million dollars fund"],
    ["Worth $2.4 billion today", "Worth two point four billion dollars today"],
    ["Between 30 and 95 stores", "Between thirty and ninety five stores"],
    ["A 30-day trial in 4K, 1st try, 3.5 stars", "A 30-day trial in 4K, 1st try, 3.5 stars"],
  ])("%s", (written, spoken) => {
    expect(expandSpokenEn(written).spoken).toBe(spoken);
  });

  it("keeps surrounding punctuation on the spoken token", () => {
    expect(expandSpokenEn('He paid ($9.99), then "$20." Done.').spoken).toBe(
      'He paid (nine ninety nine), then "twenty dollars." Done.',
    );
  });

  it.each([
    ["Only $0.05 each", "Only five cents each"],
    ["Only $0.01 each", "Only one cent each"],
    ["Only $0.50 each", "Only fifty cents each"],
    ["Owes 1000000000000 total", "Owes 1000000000000 total"],
    [
      "Owes 1,000,000,000,000,000,000,000,000 total",
      "Owes 1,000,000,000,000,000,000,000,000 total",
    ],
  ])("%s", (written, spoken) => {
    expect(expandSpokenEn(written).spoken).toBe(spoken);
  });

  it("does not glue a punctuated amount to the next scale word", () => {
    const { groups, spoken } = expandSpokenEn("Paid $5. Billion more");
    expect(spoken).toBe("Paid five dollars. Billion more");
    expect(groups.map((g) => g.display)).toEqual(["Paid", "$5.", "Billion", "more"]);
  });

  it("leaves text without numbers untouched", () => {
    const text = "Milk is not what it used to be.";
    expect(expandSpokenEn(text).spoken).toBe(text);
  });
});

describe("createSpokenTextSynthesizer en-US", () => {
  const written = "In 1999 a gallon cost $9.99, up 25%. Then $10 million moved.";
  const spoken = expandSpokenEn(written).spoken;

  /** One synthesizer word per spoken word, 100 ms each. */
  const fake = (calls: string[]): SpeechSynthesizer => ({
    async synthesize(input) {
      calls.push(input.text);
      const words: SpokenWord[] = input.text
        .split(/\s+/u)
        .map((text, i) => ({ text, startMs: i * 100, endMs: i * 100 + 100 }));
      return {
        bytes: new Uint8Array([1]),
        mimeType: "audio/wav",
        durationMs: words.length * 100,
        words,
      };
    },
  });

  it("sends the spoken form and returns captions equal to the written words", async () => {
    const calls: string[] = [];
    const result = await createSpokenTextSynthesizer(fake(calls)).synthesize({
      text: written,
      voiceId: "af_heart",
      language: "en-US",
    });
    expect(calls).toEqual([spoken]);
    expect(result.words.map((w) => w.text)).toEqual(written.split(/\s+/u));
    // "$9.99," spans "nine ninety nine," = 3 spoken words; timings come from first and last.
    const price = result.words.find((w) => w.text === "$9.99,");
    expect(price).toBeDefined();
    expect((price?.endMs ?? 0) - (price?.startMs ?? 0)).toBe(300);
    for (let i = 1; i < result.words.length; i += 1)
      expect(result.words[i]?.startMs).toBeGreaterThanOrEqual(result.words[i - 1]?.endMs ?? 0);
  });

  it("does not touch other languages", async () => {
    const calls: string[] = [];
    await createSpokenTextSynthesizer(fake(calls)).synthesize({
      text: "Costs $9.99",
      voiceId: "ef_dora",
      language: "es",
    });
    expect(calls).toEqual(["Costs $9.99"]);
  });
});
