import { describe, expect, it } from "vitest";
import type { BuyerVoice } from "./marketplace-catalog.js";
import { summarizeBuyerVoice } from "./buyer-voice.js";

const voice: BuyerVoice = {
  providerId: "MLB1",
  sourceUrl: new URL("https://www.mercadolivre.com.br/p/MLB1"),
  observedAt: new Date("2026-10-01T12:00:00Z"),
  ratingAverage: 4,
  reviewCount: 10,
  positiveReviews: [
    { rating: 5, title: "  Muito bom ", text: "Funciona bem  " },
    { rating: 5, title: "Muito bom", text: "Funciona bem" },
  ],
  negativeReviews: [{ rating: 1, title: "Ruim", text: "Quebrou rápido" }],
  questions: [
    { question: "Cabe no armário?", answer: "Sim" },
    { question: "  Cabe no armário? ", answer: "Sim" },
  ],
  pictures: [],
  unavailable: [],
};

describe("summarizeBuyerVoice", () => {
  it("deduplicates exact normalized excerpts and preserves positive, negative, and question evidence", () => {
    const summary = summarizeBuyerVoice(voice);

    expect(summary).toMatchObject({
      method: "exact_normalized_text_v1",
      sampledReviews: 3,
      uniqueReviews: 2,
      duplicateReviews: 1,
      sampledQuestions: 2,
      uniqueQuestions: 1,
      duplicateQuestions: 1,
      positiveReviewCount: 1,
      negativeReviewCount: 1,
      questionCount: 1,
      sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
      observedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(summary.evidence).toEqual([
      { kind: "positive_review", excerpt: "Muito bom — Funciona bem", rating: 5 },
      { kind: "negative_review", excerpt: "Ruim — Quebrou rápido", rating: 1 },
      { kind: "question", excerpt: "Cabe no armário?", answer: "Sim" },
    ]);
  });

  it("returns an empty digest without manufacturing evidence when sections are unavailable", () => {
    const summary = summarizeBuyerVoice({
      ...voice,
      positiveReviews: [],
      negativeReviews: [],
      questions: [],
      unavailable: ["reviews", "questions"],
    });

    expect(summary.evidence).toEqual([]);
    expect(summary.unavailable).toEqual(["reviews", "questions"]);
  });
});
