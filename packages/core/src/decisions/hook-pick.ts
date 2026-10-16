import type { DecisionProvider, DecisionResult } from "./jev-shadow.js";

/**
 * Below this Score confidence Jev's probability is spread over several levels, so the ranking is
 * not trusted and the original hook stays. ponytail: uncalibrated guess (the docs give no
 * threshold); tune it against the audited picks.
 */
export const HOOK_PICK_MIN_CONFIDENCE = 0.3;

export type HookPick = Readonly<{
  status: "picked" | "unavailable" | "low_confidence";
  /** Index into the hooks; 0 (the original) unless every hook was scored with confidence. */
  chosenIndex: number;
  scores: readonly (number | null)[];
  confidences: readonly (number | null)[];
  requestedModel: string;
  resolvedModel: string;
}>;

/**
 * Scores each hook with Jev hook_strength (minimal state) and picks the highest; ties keep the
 * earlier hook, so the original wins. Any failure or low confidence keeps the original. Never throws.
 */
export const pickStrongestHook = async (
  provider: DecisionProvider,
  input: Readonly<{
    hooks: readonly string[];
    niche: string;
    offerTitle: string;
    verifiedFacts: readonly unknown[];
  }>,
): Promise<HookPick> => {
  const settled = await Promise.allSettled(
    input.hooks.map(async (hook) =>
      provider.decide({
        name: "hook_strength",
        state: {
          hook,
          niche: input.niche,
          offerTitle: input.offerTitle,
          verifiedFacts: input.verifiedFacts,
        },
      }),
    ),
  );
  const answers = settled.map((entry) => {
    const answer = entry.status === "fulfilled" ? entry.value.answer : null;
    return answer?.type === "score" ? answer : null;
  });
  const first = settled.find(
    (entry): entry is PromiseFulfilledResult<DecisionResult> => entry.status === "fulfilled",
  )?.value;
  const scores = answers.map((answer) => answer?.score ?? null);
  const base = {
    scores,
    confidences: answers.map((answer) => answer?.confidence ?? null),
    requestedModel: first?.requestedModel ?? "",
    resolvedModel: first?.resolvedModel ?? "",
  };
  if (answers.some((answer) => answer === null))
    return { ...base, status: "unavailable", chosenIndex: 0 };
  if (answers.some((answer) => (answer?.confidence ?? 0) < HOOK_PICK_MIN_CONFIDENCE))
    return { ...base, status: "low_confidence", chosenIndex: 0 };
  let chosenIndex = 0;
  scores.forEach((score, i) => {
    if ((score ?? 0) > (scores[chosenIndex] ?? 0)) chosenIndex = i;
  });
  return { ...base, status: "picked", chosenIndex };
};
