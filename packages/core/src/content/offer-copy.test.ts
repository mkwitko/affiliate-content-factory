import { describe, expect, it } from "vitest";
import type { BuyerVoice } from "../offers/marketplace-catalog.js";
import type { CommercialFact } from "../offers/offer.js";
import {
  buildOfferCopyInput,
  buildOfferCopyMessages,
  checkOfferCopyDraft,
  copyTextCode,
  draftOfferCopyWithCorrections,
  fillOfferCopyPlaceholders,
  type OfferCopyDraft,
  offerCopyHookCandidates,
  offerCopyProblems,
  offerPlaceholders,
  repairOfferCopyDraft,
  stripModelHashtags,
  validateOfferCopyDraft,
} from "./offer-copy.js";

const facts: CommercialFact[] = [
  {
    key: "current_price",
    value: { amountMinor: 10000, currency: "BRL" },
    sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
    verified: true,
  },
  { key: "seller", value: "Loja", sourceUrl: "https://x", verified: true },
  { key: "hidden", value: 5, sourceUrl: "https://x", verified: false },
];
const slides = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1,
  total: 6,
  template: i === 0 ? ("hero" as const) : ("benefit" as const),
  headline: i === 0 ? "R$ 100 no cesto grande" : `Motivo ${i + 1}`,
  claims: i === 0 ? [{ text: "R$ 100", factKey: "current_price" }] : [],
}));
const draft: OfferCopyDraft = {
  slides,
  captions: { instagram_carousel: "Cesto grande por R$ 100", threads: "Achado por R$ 100" },
};
const context = {
  facts,
  sourceFactKeys: ["current_price", "seller"],
  slideCount: 6,
  channels: ["instagram_carousel", "threads"] as const,
  captionMaxLength: { instagram_carousel: 2200, threads: 500 },
};

describe("buildOfferCopyInput", () => {
  const long = "x".repeat(400);
  const voice = {
    positiveReviews: Array.from({ length: 5 }, () => ({ rating: 5, title: "t", text: long })),
    negativeReviews: [],
    questions: [{ question: "Serve 110v?", answer: null }],
    pictures: [{ url: "https://img/secret.jpg", width: 1, height: 1, position: 0 }],
  } as unknown as BuyerVoice;
  const input = buildOfferCopyInput({
    title: "Air fryer",
    facts,
    voice,
    niche: { name: "Casa", editorialVoice: "direta", languages: ["pt-BR"] },
    channels: ["threads"],
  });

  it("bounds and marks buyer text, keeps only verified facts, drops photos and urls", () => {
    expect(input.buyerVoice.untrusted).toBe(true);
    expect(input.buyerVoice.praise).toHaveLength(3);
    expect(input.buyerVoice.praise[0]).toHaveLength(160);
    expect(input.offer.facts.map((f) => f.key)).toEqual(["current_price", "seller"]);
    const json = JSON.stringify(input);
    expect(json).not.toMatch(/img\/secret|https?:|affiliate/i);
  });

  it("tells the model the buyer voice is untrusted", () => {
    const [system, user] = buildOfferCopyMessages(input);
    expect(system?.content).toMatch(/untrusted/);
    expect(user?.content).toContain('"untrusted":true');
  });
});

describe("validateOfferCopyDraft discount wording", () => {
  const withList: CommercialFact[] = [
    ...facts,
    {
      key: "list_price",
      value: { amountMinor: 12000, currency: "BRL" },
      sourceUrl: "https://x",
      verified: true,
    },
  ];
  const discounted = { ...draft, captions: { ...draft.captions, threads: "Em promoção, R$ 100" } };
  it("allows discount wording when list and current price are both verified", () => {
    expect(validateOfferCopyDraft(discounted, { ...context, facts: withList }).ok).toBe(true);
  });
  it("refuses it when only the current price is known", () => {
    expect(validateOfferCopyDraft(discounted, context)).toEqual({
      ok: false,
      code: "copy_discount_unverified",
    });
  });
});

describe("validateOfferCopyDraft", () => {
  it("accepts a grounded draft and adds disclosure and the Instagram CTA", () => {
    const verdict = validateOfferCopyDraft(draft, context);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.captions.instagram_carousel).toMatch(/Link na bio[\s\S]*#publi/);
    expect(verdict.captions.threads).toMatch(/#publi$/);
    expect(verdict.captions.threads).not.toMatch(/Comente/);
  });

  it("allows shipping words when free_shipping is a verified fact", () => {
    const verdict = validateOfferCopyDraft(
      { ...draft, captions: { ...draft.captions, threads: "Frete grátis incluso" } },
      {
        ...context,
        facts: [
          ...facts,
          { key: "free_shipping", value: true, sourceUrl: "https://x", verified: true },
        ],
      },
    );
    expect(verdict.ok).toBe(true);
  });

  it.each([
    [
      "slide number without a fact",
      { ...draft, slides: slides.map((s, i) => (i === 1 ? { ...s, headline: "Só R$ 37" } : s)) },
      "number_unsupported",
    ],
    [
      "claim with unknown fact key",
      {
        ...draft,
        slides: slides.map((s, i) =>
          i === 0 ? { ...s, claims: [{ text: "x", factKey: "nope" }] } : s,
        ),
      },
      "claim_unknown_fact",
    ],
    [
      "caption number without a fact",
      { ...draft, captions: { ...draft.captions, threads: "Só R$ 37" } },
      "number_unsupported",
    ],
    [
      "caption hashtags",
      { ...draft, captions: { ...draft.captions, threads: "oi #promo" } },
      "caption_hashtags",
    ],
    ["missing caption", { ...draft, captions: { threads: "ok" } }, "caption_missing"],
    [
      "too long for the channel",
      { ...draft, captions: { ...draft.captions, threads: "a".repeat(600) } },
      "caption_too_long",
    ],
    ...[
      ["caption url", "veja https://x.co/a", "copy_link_not_allowed"],
      ["caption www", "veja www.loja.com", "copy_link_not_allowed"],
      ["caption bare domain", "so em loja.com.br", "copy_link_not_allowed"],
      ["caption handle", "fale com @loja", "copy_mention_not_allowed"],
      ["caption frete", "com frete rapido", "copy_shipping_unverified"],
      ["caption price date", "Preço visto em 28/09 (o preço muda)", "copy_price_date"],
      ["caption entrega gratis", "Entrega grátis hoje", "copy_shipping_unverified"],
      ["caption desconto", "Com desconto imperdivel", "copy_discount_unverified"],
      ["caption off", "Aproveite, 20% OFF", "copy_discount_unverified"],
      ["caption promocao", "Em promoção agora", "copy_discount_unverified"],
    ].map(
      ([name, threads, code]) =>
        [name, { ...draft, captions: { ...draft.captions, threads } }, code] as const,
    ),
    [
      "slide with a discount badge",
      { ...draft, slides: slides.map((s, i) => (i === 2 ? { ...s, badge: "Desconto" } : s)) },
      "copy_discount_unverified",
    ],
    [
      "slide with a link",
      { ...draft, slides: slides.map((s, i) => (i === 2 ? { ...s, body: "em x.co/a" } : s)) },
      "copy_link_not_allowed",
    ],
    [
      "slide with free shipping unverified",
      { ...draft, slides: slides.map((s, i) => (i === 2 ? { ...s, badge: "Envio grátis" } : s)) },
      "copy_shipping_unverified",
    ],
    [
      "voice line with an unbacked number",
      {
        ...draft,
        slides: slides.map((s, i) => (i === 1 ? { ...s, voiceLine: "Só hoje R$ 37!" } : s)),
      },
      "number_unsupported",
    ],
    [
      "voice line with a testimonial",
      {
        ...draft,
        slides: slides.map((s, i) => (i === 1 ? { ...s, voiceLine: "Eu testei e amei" } : s)),
      },
      "claim_testimonial",
    ],
    [
      "voice line too long",
      {
        ...draft,
        slides: slides.map((s, i) => (i === 1 ? { ...s, voiceLine: "x".repeat(141) } : s)),
      },
      "voice_line_too_long",
    ],
    [
      "wrong slide count",
      { ...draft, slides: slides.slice(0, 5).map((s) => ({ ...s, total: 5 })) },
      "slide_count",
    ],
    [
      "generic hook",
      { ...draft, slides: slides.map((s, i) => (i === 0 ? { ...s, headline: "Imperdível" } : s)) },
      "quality_generic_hook",
    ],
  ] as const)("rejects: %s", (_name, bad, code) => {
    expect(validateOfferCopyDraft(bad as unknown as OfferCopyDraft, context)).toEqual({
      ok: false,
      code,
    });
  });
});

const input0 = (f: CommercialFact[]) =>
  buildOfferCopyInput({
    title: "t",
    facts: f,
    voice: null,
    niche: { name: "Casa", editorialVoice: "d", languages: ["pt-BR"] },
    channels: ["threads"],
  });

describe("offer placeholders", () => {
  const withList: CommercialFact[] = [
    ...facts,
    {
      key: "list_price",
      value: { amountMinor: 20000, currency: "BRL" },
      sourceUrl: "https://x",
      verified: true,
    },
  ];
  const text = (t: string): OfferCopyDraft => ({
    slides: draft.slides.map((s, i) => (i === 0 ? { ...s, headline: t, claims: [] } : s)),
    captions: { instagram_carousel: `Por ${t}`, threads: "Achado" },
  });

  it("never doubles the percent sign when the model writes {desconto}%", () => {
    const filled = fillOfferCopyPlaceholders(text("Agora {desconto}% mais barato"), withList);
    expect(filled.ok && filled.draft.slides[0]?.headline).toBe("Agora 50% mais barato");
  });

  it("offers only what the facts support", () => {
    expect(Object.keys(offerPlaceholders(facts))).toEqual(["{preco}"]);
    expect(Object.keys(offerPlaceholders(withList))).toEqual([
      "{preco}",
      "{preco_antigo}",
      "{desconto}",
    ]);
    expect(Object.keys(offerPlaceholders([]))).toEqual([]);
    expect(buildOfferCopyMessages(input0(withList))[0]?.content).toContain("{desconto}");
    expect(buildOfferCopyMessages(input0(facts))[0]?.content).toMatch(
      /type them exactly\): \{preco\}\.$/,
    );
  });

  it("fills them before validation so numbers come from evidence", () => {
    const filled = fillOfferCopyPlaceholders(
      text("{preco} (de {preco_antigo}, {desconto})"),
      withList,
    );
    expect(filled.ok && filled.draft.slides[0]?.headline).toBe("R$ 100,00 (de R$ 200,00, 50%)");
    if (!filled.ok) throw new Error("unreachable");
    expect(validateOfferCopyDraft(filled.draft, { ...context, facts: withList })).toMatchObject({
      ok: true,
    });
  });

  it("rejects unknown placeholders and ones the offer cannot support", () => {
    expect(fillOfferCopyPlaceholders(text("{frete}"), withList)).toEqual({
      ok: false,
      code: "copy_placeholder_unknown",
    });
    expect(fillOfferCopyPlaceholders(text("{preco_antigo}"), facts)).toEqual({
      ok: false,
      code: "copy_placeholder_unknown",
    });
  });

  it("still rejects typed digits that no fact backs", () => {
    expect(validateOfferCopyDraft(text("Só R$ 79"), context)).toEqual({
      ok: false,
      code: "number_unsupported",
    });
  });
});

describe("stripModelHashtags", () => {
  it("drops model hashtags, counts them, and leaves clean captions alone", () => {
    const stripped = stripModelHashtags({
      slides,
      captions: { instagram_carousel: "Cesto grande #casa #Organização  hoje", threads: "Achado" },
    });
    expect(stripped.strippedHashtags).toBe(2);
    expect(stripped.draft.captions).toEqual({
      instagram_carousel: "Cesto grande hoje",
      threads: "Achado",
    });
    expect(stripModelHashtags(draft).strippedHashtags).toBe(0);
  });

  it("makes a hashtagged draft pass, while a caption of only hashtags is still missing", () => {
    const tagged = {
      slides,
      captions: { instagram_carousel: "Cesto por R$ 100 #casa", threads: "Achado #x" },
    };
    expect(validateOfferCopyDraft(tagged, context)).toEqual({
      ok: false,
      code: "caption_hashtags",
    });
    expect(validateOfferCopyDraft(stripModelHashtags(tagged).draft, context).ok).toBe(true);
  });
});

describe("repairOfferCopyDraft", () => {
  const withSlide = (index: number, over: Record<string, unknown>): OfferCopyDraft => ({
    ...draft,
    slides: slides.map((s, i) => (i === index ? { ...s, ...over } : s)),
  });
  const repair = (d: OfferCopyDraft) => repairOfferCopyDraft(d, facts, context.sourceFactKeys);

  it("leaves a clean draft exactly as it is", () => {
    expect(repair(draft)).toEqual({ draft, removed: [] });
  });

  it.each([
    [{ text: "Da Loja", factKey: "rating" }, "claim_unknown_fact"],
    [{ text: "Escondido", factKey: "hidden" }, "claim_unknown_fact"],
    [{ text: "veja loja.com.br" }, "copy_link_not_allowed"],
    [{ text: "siga @loja" }, "copy_mention_not_allowed"],
    [{ text: "Nota 4,9" }, "number_unsupported"],
    [{ text: "Com desconto" }, "copy_discount_unverified"],
    [{ text: "Frete grátis" }, "copy_shipping_unverified"],
    [{ text: "Só {desconto}" }, "copy_placeholder_unknown"],
    [{ text: "Testei e aprovei" }, "claim_testimonial"],
    [{ text: "Resultado garantido" }, "claim_guarantee"],
    [{ text: "Super prático", factKey: "seller" }, "claim_fact_mismatch"],
  ])("drops the claim %j (%s) and keeps the others", (claim, code) => {
    const kept = { text: "R$ 100", factKey: "current_price" };
    const { draft: repaired, removed } = repair(withSlide(0, { claims: [kept, claim] }));
    expect(repaired.slides[0]?.claims).toEqual([kept]);
    expect(removed).toEqual([{ where: "slide 1 claim", text: claim.text, code }]);
  });

  it("drops only the bad sentences of a body and removes a badge that becomes empty", () => {
    const { draft: repaired, removed } = repair(
      withSlide(1, {
        body: "Cabe tudo. Só hoje R$ 37! Por {preco}?\nFácil de limpar.",
        badge: "Frete grátis",
      }),
    );
    expect(repaired.slides[1]).not.toHaveProperty("badge");
    expect(repaired.slides[1]?.body).toBe("Cabe tudo. Por {preco}?\nFácil de limpar.");
    expect(removed).toEqual([
      { where: "slide 2 body", text: "Só hoje R$ 37!", code: "number_unsupported" },
      { where: "slide 2 badge", text: "Frete grátis", code: "copy_shipping_unverified" },
    ]);
  });

  it("repairs and fills a voice line like a body, dropping it when nothing is left", () => {
    const { draft: repaired, removed } = repair(
      withSlide(1, { voiceLine: "Cabe tudo. Só hoje R$ 37! Custa {preco}." }),
    );
    expect(repaired.slides[1]?.voiceLine).toBe("Cabe tudo. Custa {preco}.");
    expect(removed).toEqual([
      { where: "slide 2 voiceLine", text: "Só hoje R$ 37!", code: "number_unsupported" },
    ]);
    expect(repair(withSlide(1, { voiceLine: "Em promoção." })).draft.slides[1]).not.toHaveProperty(
      "voiceLine",
    );
    const filled = fillOfferCopyPlaceholders(repaired, facts);
    expect(filled.ok && filled.draft.slides[1]?.voiceLine).toBe("Cabe tudo. Custa R$ 100,00.");
  });

  it("removes a body that becomes empty", () => {
    const { draft: repaired } = repair(withSlide(2, { body: "Em promoção." }));
    expect(repaired.slides[2]).not.toHaveProperty("body");
  });

  it("never edits a headline: that is left to the correction loop", () => {
    const bad = withSlide(1, { headline: "Só R$ 37 hoje. Corra" });
    const { draft: repaired, removed } = repair(bad);
    expect(repaired.slides[1]?.headline).toBe("Só R$ 37 hoje. Corra");
    expect(removed).toEqual([]);
    expect(validateOfferCopyDraft(repaired, context)).toEqual({
      ok: false,
      code: "number_unsupported",
    });
  });

  it("keeps a caption that becomes empty empty, so validation still fails", () => {
    const bad = { ...draft, captions: { ...draft.captions, threads: "Veja www.loja.com" } };
    const { draft: repaired } = repair(bad);
    expect(repaired.captions.threads).toBe("");
    expect(validateOfferCopyDraft(repaired, context)).toEqual({
      ok: false,
      code: "caption_missing",
    });
  });

  it("makes a draft with only removable faults pass, adding nothing", () => {
    const bad: OfferCopyDraft = {
      slides: slides.map((s, i) =>
        i === 1
          ? {
              ...s,
              body: "Cabe tudo. Nota 4,9 no site!",
              badge: "Com 50% off",
              claims: [{ text: "Entrega grátis" }, { text: "Loja oficial", factKey: "seller" }],
            }
          : s,
      ),
      captions: {
        instagram_carousel: "Cesto grande por {preco}. Veja em loja.com.br\n\nSó com @loja!",
        threads: "Achado por {preco}. Em promoção relâmpago!",
      },
    };
    const before = fillOfferCopyPlaceholders(bad, facts);
    expect(before.ok && validateOfferCopyDraft(before.draft, context).ok).toBe(false);
    const { draft: repaired, removed } = repair(bad);
    expect(removed.map((r) => r.code)).toEqual([
      "copy_shipping_unverified",
      "number_unsupported",
      "copy_discount_unverified",
      "copy_link_not_allowed",
      "copy_mention_not_allowed",
      "copy_discount_unverified",
    ]);
    const filled = fillOfferCopyPlaceholders(repaired, facts);
    expect(filled.ok && validateOfferCopyDraft(filled.draft, context).ok).toBe(true);
    // Nothing added: every kept text is a piece of the original text at the same place.
    const original = JSON.stringify(bad);
    for (const slide of repaired.slides)
      for (const text of [slide.headline, slide.body ?? "", ...slide.claims.map((c) => c.text)])
        expect(original).toContain(JSON.stringify(text).slice(1, -1));
    expect(repaired.captions).toEqual({
      instagram_carousel: "Cesto grande por {preco}.",
      threads: "Achado por {preco}.",
    });
  });
});

describe("offer copy claims", () => {
  it("rejects a headline that invents a testimonial and tells the model why", () => {
    const testimonial = {
      ...draft,
      slides: slides.map((s, i) => (i === 1 ? { ...s, headline: "Testei e amei esse cesto" } : s)),
    };
    const check = checkOfferCopyDraft(testimonial, context);
    expect(check).toMatchObject({ ok: false, code: "claim_testimonial" });
    if (check.ok) return;
    expect(offerCopyProblems(check, context).join(" ")).toContain("nobody tested it");
  });
});

describe("offer copy corrections", () => {
  const headlineDiscount = {
    ...draft,
    slides: slides.map((s, i) => (i === 1 ? { ...s, headline: "Desconto no cesto" } : s)),
  };

  it("names the offending headline and what to do", () => {
    const check = checkOfferCopyDraft(headlineDiscount, context);
    expect(check).toMatchObject({ ok: false, code: "copy_discount_unverified" });
    if (check.ok) return;
    expect(offerCopyProblems(check, context)).toEqual([
      'Slide 2 headline "Desconto no cesto" mentions a discount or promotion but this offer has no verified discount: rewrite it without discounts or prices. Rewrite this headline.',
    ]);
  });

  it("reports emptied captions, removed parts and structural failures", () => {
    const bad = {
      slides: slides.map((s, i) => (i === 1 ? { ...s, headline: slides[2]?.headline ?? "" } : s)),
      captions: { ...draft.captions, threads: "Frete grátis" },
    };
    const check = checkOfferCopyDraft(bad, context);
    if (check.ok) throw new Error("expected failure");
    expect(offerCopyProblems(check, context)).toEqual([
      "The threads caption is empty (its sentences broke the rules and were removed): write a new one using only the listed facts.",
      "Two slides repeat the same copy: make every slide different.",
      'Removed from caption threads: "Frete grátis" (copy_shipping_unverified). Do not write it again.',
    ]);
  });

  it("appends the previous JSON and the problems as a follow-up turn", () => {
    const input = buildOfferCopyInput({
      title: "t",
      facts,
      voice: null,
      niche: { name: "n", editorialVoice: "v", languages: ["pt-BR"] },
      channels: ["threads"],
    });
    const messages = buildOfferCopyMessages(input, { previous: draft, problems: ["Fix A"] });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(messages[2]?.content).toBe(JSON.stringify(draft));
    expect(messages[3]?.content).toContain("- Fix A");
    expect(buildOfferCopyMessages(input)).toHaveLength(2);
  });

  it("corrects up to twice, sending the repaired draft back", async () => {
    const calls: unknown[] = [];
    const replies: unknown[] = [headlineDiscount, { junk: 1 }, draft];
    const outcome = await draftOfferCopyWithCorrections(async (correction) => {
      calls.push(correction);
      return replies[calls.length - 1];
    }, context);
    expect(outcome).toMatchObject({ attempts: 3, repairs: 0, check: { ok: true } });
    expect(calls[0]).toBeUndefined();
    expect(calls[1]).toMatchObject({ previous: headlineDiscount });
    expect(calls[2]).toBeUndefined(); // an unusable reply is asked again from scratch
  });

  it("stops after three model calls", async () => {
    let n = 0;
    const outcome = await draftOfferCopyWithCorrections(async () => {
      n += 1;
      return headlineDiscount;
    }, context);
    expect(n).toBe(3);
    expect(outcome).toMatchObject({ attempts: 3, check: { ok: false } });
  });
});

describe("offerCopyHookCandidates", () => {
  const ok = checkOfferCopyDraft(draft, context);
  if (!ok.ok) throw new Error("fixture draft must pass");
  const option = (headline: string, captionFirstLine = "Achado da semana para a casa.") => ({
    headline,
    captionFirstLine,
  });

  it("keeps the original first and only options that pass every gate, filled from facts", () => {
    const candidates = offerCopyHookCandidates(
      ok,
      {
        hookOptions: [
          option("Cesto grande por {preco}"),
          option("Só R$ 79 hoje"), // number without evidence
          option("R$ 100 no cesto grande"), // same as the original
          option("Sobra espaço no armário"),
        ],
      },
      context,
    );
    expect(candidates.map((c) => c.filled.slides[0]?.headline)).toEqual([
      "R$ 100 no cesto grande",
      "Cesto grande por R$ 100,00",
      "Sobra espaço no armário",
    ]);
    expect(candidates[1]?.captions.threads).toMatch(/^Achado da semana para a casa\./);
    expect(candidates[1]?.filled.slides.slice(1)).toEqual(ok.filled.slides.slice(1));
  });

  it.each([
    ["an unavailable placeholder", option("{desconto} no cesto")],
    ["a repeated slide", option("Motivo 2")],
    ["a generic opener", option("Confira o cesto")],
    ["unverified shipping", option("Frete grátis no cesto")],
    ["a link in the caption line", option("Cesto grande: veja", "Veja em www.loja.com")],
    ["a hashtag in the caption line", option("Cesto grande: veja", "Veja #casa")],
    ["an overlong headline", option("x".repeat(61))],
  ])("drops an option with %s", (_, bad) => {
    expect(offerCopyHookCandidates(ok, { hookOptions: [bad] }, context)).toHaveLength(1);
  });

  it("caps options at four and ignores a missing or malformed list", () => {
    const many = Array.from({ length: 6 }, (_, i) => option(`Gancho concreto ${"abcdef"[i]}`));
    expect(offerCopyHookCandidates(ok, { hookOptions: many }, context)).toHaveLength(5);
    expect(offerCopyHookCandidates(ok, null, context)).toHaveLength(1);
    expect(
      offerCopyHookCandidates(ok, { hookOptions: [1, { headline: 2 }] }, context),
    ).toHaveLength(1);
  });
});

describe("generic phrase and quality gates", () => {
  const withBody = (body: string): OfferCopyDraft => ({
    ...draft,
    slides: draft.slides.map((s, i) => (i === 1 ? { ...s, body } : s)),
  });

  it.each([
    "Organize sua rotina com esta estante",
    "Oferta especial disponível agora",
    "Garanta já a sua",
    "Garanta o seu hoje",
    "Não perca",
    "Perfeito para a sala",
    "Ideal para guardar itens",
    "Peça de qualidade",
    "Chega de bagunça!",
    "Clique no link",
  ])("rejects %s", (text) => {
    expect(validateOfferCopyDraft(withBody(text), context)).toEqual({
      ok: false,
      code: "copy_generic_phrase",
    });
  });

  it("rejects unverified quality adjectives unless the title says them", () => {
    const verdict = validateOfferCopyDraft(withBody("Material resistente e durável"), context);
    expect(verdict).toEqual({ ok: false, code: "claim_quality" });
    expect(
      validateOfferCopyDraft(withBody("Material resistente"), {
        ...context,
        offerTitle: "Estante resistente 3 prateleiras",
      }).ok,
    ).toBe(true);
  });

  it("repairs a bad body sentence and tells the model why", () => {
    const check = checkOfferCopyDraft(
      withBody("Toalha em cima. Ideal para guardar itens."),
      context,
    );
    expect(check.removed.map((r) => r.code)).toEqual(["copy_generic_phrase"]);
    const bad = checkOfferCopyDraft(
      {
        ...draft,
        slides: draft.slides.map((s, i) => (i === 0 ? { ...s, headline: "Garanta já o seu" } : s)),
      },
      context,
    );
    if (bad.ok) throw new Error("expected rejection");
    expect(offerCopyProblems(bad, context).join("\n")).toMatch(/catalogue filler/);
  });
});

describe("offer copy fixes from the 2026-10-08 owner run", () => {
  it("rejects prompt text leaking into copy", () => {
    expect(copyTextCode(["O que o título diz sobre o uso"], facts)).toBe("copy_generic_phrase");
  });
});
