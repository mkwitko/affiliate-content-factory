import { performance } from "node:perf_hooks";
import {
  JEV_QUESTIONS,
  type DecisionAnswer,
  type DecisionProvider,
  type DecisionRequest,
} from "@money-maker/core/decisions/jev-shadow";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const unit = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const probabilities = (value: unknown): value is Record<string, number> =>
  record(value) && Object.values(value).every(unit);
const nonnegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const parseAnswer = (value: unknown, request: DecisionRequest): DecisionAnswer | null => {
  if (!record(value)) return null;
  const question = JEV_QUESTIONS[request.name];
  if (value.type !== question.type) return null;
  if (value.type === "noul") return unit(value.noul) ? { type: "noul", noul: value.noul } : null;
  if (!unit(value.confidence) || !probabilities(value.probabilities)) return null;
  if (value.type === "choice" && question.type === "choice") {
    if (typeof value.choice !== "string" || !Object.hasOwn(question.criteria, value.choice))
      return null;
    if (Object.keys(value.probabilities).some((key) => !Object.hasOwn(question.criteria, key)))
      return null;
    return {
      type: "choice",
      choice: value.choice,
      probabilities: value.probabilities,
      confidence: value.confidence,
    };
  }
  if (value.type === "score" && question.type === "score") {
    if (
      typeof value.score !== "number" ||
      !Number.isFinite(value.score) ||
      value.score < 0 ||
      value.score > question.criteria.length - 1 ||
      !record(value.legend) ||
      !Object.values(value.legend).every((entry) => typeof entry === "string")
    )
      return null;
    return {
      type: "score",
      score: value.score,
      legend: value.legend as Record<string, string>,
      probabilities: value.probabilities,
      confidence: value.confidence,
    };
  }
  return null;
};

export const createJevDecisionProvider = (
  options: Readonly<{
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
  }>,
): DecisionProvider => {
  const origin = new URL(options.baseUrl ?? "https://api.typesafe.ai");
  if (origin.origin !== "https://api.typesafe.ai") throw new Error("jev_base_url_invalid");
  if (!options.apiKey) throw new Error("jev_api_key_required");
  const requestedModel = options.model ?? "jev-latest";
  const doFetch = options.fetch ?? fetch;
  return {
    async decide(request: DecisionRequest) {
      const question = JEV_QUESTIONS[request.name];
      const state = JSON.stringify(request.state);
      if (state.length > 16_000) throw new Error("jev_state_too_large");
      const started = performance.now();
      let response: Response;
      try {
        response = await doFetch(new URL("/v1/systemone", origin), {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            state: request.state,
            model: requestedModel,
            questions: { [request.name]: question },
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
          redirect: "error",
        });
      } catch {
        throw new Error("jev_unavailable");
      }
      if (!response.ok) throw new Error(`jev_http_${response.status}`);
      const payload: unknown = await response.json().catch(() => null);
      if (
        !record(payload) ||
        typeof payload.model !== "string" ||
        !payload.model ||
        payload.model.length > 100 ||
        !record(payload.answers) ||
        !record(payload.usage) ||
        !nonnegativeInt(payload.usage.input_tokens) ||
        !nonnegativeInt(payload.usage.output_tokens)
      )
        throw new Error("jev_response_invalid");
      const answer = parseAnswer(payload.answers[request.name], request);
      if (!answer) throw new Error("jev_response_invalid");
      return {
        requestedModel,
        resolvedModel: payload.model,
        answer,
        usage: {
          input_tokens: payload.usage.input_tokens,
          output_tokens: payload.usage.output_tokens,
        },
        latencyMs: Math.round(performance.now() - started),
      };
    },
  };
};
