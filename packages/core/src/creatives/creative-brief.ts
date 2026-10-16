import type { ChannelKind } from "../channels/channel.js";
import type { OpportunityBrief } from "../research/opportunity-brief.js";

type BuyerEvidence = OpportunityBrief["signals"]["buyerVoice"]["evidence"][number];

export type CreativeBrief = Readonly<{
  externalEvidenceIsUntrusted: true;
  objective: "sale";
  audience: Readonly<{ value: string; source: "operator_input" }>;
  format: ChannelKind;
  angle: "buyer_pain" | "buyer_outcome" | "answer_buyer_question" | "product_demonstration";
  hook: Readonly<{
    strategy:
      | "open_with_observed_pain"
      | "show_observed_outcome"
      | "answer_observed_question"
      | "demonstrate_product";
    evidence: Readonly<{
      kind: BuyerEvidence["kind"];
      excerpt: string;
      sourceUrl: string;
      observedAt: string;
    }> | null;
  }>;
  visualStrategy: Readonly<{
    productReference: string;
    guidance: "preserve_product_identity_add_context_only";
  }>;
  cta: "direct_offer" | "product_information_only";
  generatorCapability: "existing_channel_pipeline";
  claims: readonly [];
}>;

const evidencePriority: readonly BuyerEvidence["kind"][] = [
  "negative_review",
  "question",
  "positive_review",
];

const directionFor = (kind: BuyerEvidence["kind"] | undefined) => {
  if (kind === "negative_review")
    return { angle: "buyer_pain" as const, strategy: "open_with_observed_pain" as const };
  if (kind === "question")
    return {
      angle: "answer_buyer_question" as const,
      strategy: "answer_observed_question" as const,
    };
  if (kind === "positive_review")
    return { angle: "buyer_outcome" as const, strategy: "show_observed_outcome" as const };
  return { angle: "product_demonstration" as const, strategy: "demonstrate_product" as const };
};

export const createCreativeBrief = (input: {
  offer: OpportunityBrief["offer"];
  channelKind: ChannelKind;
  audience: string;
  buyerVoice: OpportunityBrief["signals"]["buyerVoice"];
}): CreativeBrief => {
  const evidence = evidencePriority
    .map((kind) => input.buyerVoice.evidence.find((item) => item.kind === kind))
    .find((item): item is BuyerEvidence => item !== undefined);
  const direction = directionFor(evidence?.kind);
  return {
    externalEvidenceIsUntrusted: true,
    objective: "sale",
    audience: { value: input.audience.trim(), source: "operator_input" },
    format: input.channelKind,
    angle: direction.angle,
    hook: {
      strategy: direction.strategy,
      evidence:
        evidence && input.buyerVoice.sourceUrl && input.buyerVoice.observedAt
          ? {
              kind: evidence.kind,
              excerpt: evidence.excerpt,
              sourceUrl: input.buyerVoice.sourceUrl,
              observedAt: input.buyerVoice.observedAt,
            }
          : null,
    },
    visualStrategy: {
      productReference: input.offer.listingUrl,
      guidance: "preserve_product_identity_add_context_only",
    },
    cta: input.offer.affiliateLinkAvailable ? "direct_offer" : "product_information_only",
    generatorCapability: "existing_channel_pipeline",
    claims: [],
  };
};
