import { describe, expect, it } from "vitest";
import type { OpportunityBrief } from "../research/opportunity-brief.js";
import { createCreativeBrief } from "./creative-brief.js";

const offer: OpportunityBrief["offer"] = {
  id: "offer-1",
  marketplace: "mercado_livre",
  title: "Organizador compacto",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB123",
  affiliateLinkAvailable: true,
};

describe("createCreativeBrief", () => {
  it("uses a real pain excerpt as direction without turning it into a product claim", () => {
    const brief = createCreativeBrief({
      offer,
      channelKind: "instagram_carousel",
      audience: "pessoas com pouco espaço na cozinha",
      buyerVoice: {
        status: "observed",
        unavailableReason: null,
        positiveReviews: 0,
        negativeReviews: 1,
        questions: 0,
        evidence: [{ kind: "negative_review", excerpt: "A tampa não fecha direito", rating: 1 }],
        sourceUrl: "https://www.mercadolivre.com.br/p/MLB123",
        observedAt: "2026-10-01T12:00:00.000Z",
      },
    });

    expect(brief).toMatchObject({
      objective: "sale",
      audience: { value: "pessoas com pouco espaço na cozinha", source: "operator_input" },
      format: "instagram_carousel",
      angle: "buyer_pain",
      hook: {
        strategy: "open_with_observed_pain",
        evidence: {
          excerpt: "A tampa não fecha direito",
          sourceUrl: "https://www.mercadolivre.com.br/p/MLB123",
        },
      },
      cta: "direct_offer",
      claims: [],
    });
  });

  it("falls back to product demonstration when buyer evidence is unavailable", () => {
    const brief = createCreativeBrief({
      offer: { ...offer, affiliateLinkAvailable: false },
      channelKind: "threads",
      audience: "operador-defined audience",
      buyerVoice: {
        status: "missing",
        unavailableReason: "provider_unavailable",
        positiveReviews: 0,
        negativeReviews: 0,
        questions: 0,
        evidence: [],
        sourceUrl: null,
        observedAt: null,
      },
    });
    expect(brief).toMatchObject({
      angle: "product_demonstration",
      hook: { strategy: "demonstrate_product", evidence: null },
      cta: "product_information_only",
      claims: [],
    });
  });
});
