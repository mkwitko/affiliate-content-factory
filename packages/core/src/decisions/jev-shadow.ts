/** Closed Jev v1 questions. Answers are advisory; deterministic gates keep authority. */
export const JEV_QUESTIONS = {
  creative_format: {
    type: "choice",
    instructions: "Which storytelling format best fits this approved creative brief?",
    criteria: {
      REVIEW_READING: "Read and interpret review evidence",
      PROBLEM_SOLUTION: "Show a buyer problem and a supported solution",
      PRICE_REVEAL: "Reveal a verified current price",
      SKEPTIC_ARC: "Address a supported buyer objection",
      LISTICLE_3: "Three evidence-backed points",
      BEFORE_AFTER: "Compare a supported before and after",
    },
  },
  generation_route: {
    type: "choice",
    instructions: "Which visual route best fits the validated storyboard?",
    criteria: {
      STATIC_ONLY: "Use existing still images or slideshow",
      STICKMAN: "Render existing SceneSpec motion",
      LOCAL_IMAGE: "Generate a local scene image",
      LOCAL_I2V: "Animate an approved image reference locally",
      LOCAL_T2V: "Generate a local video from text",
      CLOUD_PREMIUM: "Use an approved hosted clip provider",
    },
  },
  hook_strength: {
    type: "score",
    instructions: "How strongly does the hook earn attention without inventing facts?",
    criteria: ["weak", "modest", "clear", "strong"],
  },
  commercial_strength: {
    type: "score",
    instructions: "How clearly does the creative connect a verified offer to a buyer need?",
    criteria: ["weak", "modest", "clear", "strong"],
  },
  claim_risk: {
    type: "score",
    instructions: "How much does the creative appear to require claim verification?",
    criteria: ["low", "moderate", "high", "critical"],
  },
  should_regenerate: {
    type: "noul",
    instructions:
      "Would another generation likely improve this creative after deterministic validation?",
  },
  should_escalate: {
    type: "noul",
    instructions: "Should a human inspect this deterministic validation failure?",
  },
} as const;

export type DecisionName = keyof typeof JEV_QUESTIONS;
export type DecisionRequest = Readonly<{
  name: DecisionName;
  state: Readonly<Record<string, unknown>>;
}>;
export type DecisionAnswer =
  | Readonly<{
      type: "choice";
      choice: string;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    }>
  | Readonly<{
      type: "score";
      score: number;
      legend: Readonly<Record<string, string>>;
      probabilities: Readonly<Record<string, number>>;
      confidence: number;
    }>
  | Readonly<{ type: "noul"; noul: number }>;
export type DecisionResult = Readonly<{
  requestedModel: string;
  resolvedModel: string;
  answer: DecisionAnswer;
  usage: Readonly<{ input_tokens: number; output_tokens: number }>;
  latencyMs: number;
}>;
export interface DecisionProvider {
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export type ShadowEvidence = Readonly<{
  schemaVersion: 1;
  name: DecisionName;
  existingChoice: string;
  validatorResult: string;
  finalAcceptedRoute: string;
  status: "answered" | "unavailable";
  requestedModel?: string;
  resolvedModel?: string;
  answer?: DecisionAnswer;
  usage?: DecisionResult["usage"];
  latencyMs?: number;
}>;

/** Shadow mode never changes the choice, even when the provider or evidence store fails. */
export const evaluateJevShadow = async (
  provider: DecisionProvider,
  input: DecisionRequest &
    Readonly<{ existingChoice: string; validatorResult: string; finalAcceptedRoute: string }>,
  record: (evidence: ShadowEvidence) => Promise<void>,
): Promise<string> => {
  const base = {
    schemaVersion: 1 as const,
    name: input.name,
    existingChoice: input.existingChoice,
    validatorResult: input.validatorResult,
    finalAcceptedRoute: input.finalAcceptedRoute,
  };
  try {
    const result = await provider.decide({ name: input.name, state: input.state });
    await record({ ...base, status: "answered", ...result });
  } catch {
    try {
      await record({ ...base, status: "unavailable" });
    } catch {
      // Optional shadow evidence cannot roll back the accepted storyboard.
    }
  }
  return input.existingChoice;
};
