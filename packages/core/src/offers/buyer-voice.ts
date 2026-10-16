import type { BuyerVoice } from "./marketplace-catalog.js";

type BuyerVoiceEvidence =
  | Readonly<{ kind: "positive_review" | "negative_review"; excerpt: string; rating: number }>
  | Readonly<{ kind: "question"; excerpt: string; answer: string | null }>;

export type BuyerVoiceSummary = Readonly<{
  method: "exact_normalized_text_v1";
  sourceUrl: string;
  observedAt: string;
  sampledReviews: number;
  uniqueReviews: number;
  duplicateReviews: number;
  sampledQuestions: number;
  uniqueQuestions: number;
  duplicateQuestions: number;
  positiveReviewCount: number;
  negativeReviewCount: number;
  questionCount: number;
  unavailable: BuyerVoice["unavailable"];
  evidence: readonly BuyerVoiceEvidence[];
}>;

const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");
const key = (value: string) => normalize(value).toLocaleLowerCase("pt-BR");

export const summarizeBuyerVoice = (voice: BuyerVoice): BuyerVoiceSummary => {
  const reviewKeys = new Set<string>();
  const questionKeys = new Set<string>();
  const evidence: BuyerVoiceEvidence[] = [];
  let positiveReviewCount = 0;
  let negativeReviewCount = 0;

  const addReviews = (
    reviews: BuyerVoice["positiveReviews"],
    kind: "positive_review" | "negative_review",
  ) => {
    for (const review of reviews) {
      const title = normalize(review.title);
      const text = normalize(review.text);
      if (!text) continue;
      const identity = `${review.rating}\u0000${key(title)}\u0000${key(text)}`;
      if (reviewKeys.has(identity)) continue;
      reviewKeys.add(identity);
      if (kind === "positive_review") positiveReviewCount += 1;
      else negativeReviewCount += 1;
      evidence.push({
        kind,
        excerpt: title ? `${title} — ${text}` : text,
        rating: review.rating,
      });
    }
  };

  addReviews(voice.positiveReviews, "positive_review");
  addReviews(voice.negativeReviews, "negative_review");

  for (const item of voice.questions) {
    const question = normalize(item.question);
    if (!question) continue;
    const answer = item.answer ? normalize(item.answer) : null;
    const identity = `${key(question)}\u0000${answer ? key(answer) : ""}`;
    if (questionKeys.has(identity)) continue;
    questionKeys.add(identity);
    evidence.push({ kind: "question", excerpt: question, answer });
  }

  const sampledReviews = voice.positiveReviews.length + voice.negativeReviews.length;
  return {
    method: "exact_normalized_text_v1",
    sourceUrl: voice.sourceUrl.toString(),
    observedAt: voice.observedAt.toISOString(),
    sampledReviews,
    uniqueReviews: reviewKeys.size,
    duplicateReviews: sampledReviews - reviewKeys.size,
    sampledQuestions: voice.questions.length,
    uniqueQuestions: questionKeys.size,
    duplicateQuestions: voice.questions.length - questionKeys.size,
    positiveReviewCount,
    negativeReviewCount,
    questionCount: questionKeys.size,
    unavailable: voice.unavailable,
    evidence,
  };
};
