import { describe, expect, it } from "vitest";
import type { CommercialFact } from "../offers/offer.js";
import { copyClaimProblems, forbiddenClaimReason, verifyClaim } from "./claim-verifier.js";

const url = "https://www.mercadolivre.com.br/p/MLB1";
const fact = (key: string, value: CommercialFact["value"]): CommercialFact => ({
  key,
  value,
  sourceUrl: url,
  verified: true,
});
const brl = (amountMinor: number) => ({ amountMinor, currency: "BRL" });
const facts = [
  fact("current_price", brl(4290)),
  fact("list_price", brl(5990)),
  fact("seller", "Loja Casa Bonita"),
  fact("free_shipping", false),
  fact("sold_quantity", 12000),
  fact("rating_average", 4.8),
];

describe("verifyClaim", () => {
  it.each([
    ["Testei por 30 dias e aprovei", "testimonial"],
    ["Eu uso todo dia aqui em casa", "testimonial"],
    ["Os clientes amam esse cesto", "testimonial"],
    ["Dermatologistas recomendam", "testimonial"],
    ["Dermatologicamente testado", "certification"],
    ["Aprovado pela Anvisa", "certification"],
    ["Hipoalergênico e seguro", "certification"],
    ["Resultado garantido em uma semana", "guarantee"],
    ["Nunca mais quebra", "guarantee"],
    ["Dura para sempre", "guarantee"],
    ["O melhor do mercado", "ranking"],
    ["Número 1 do Brasil", "ranking"],
    ["Elimina rugas de vez", "health"],
    ["Emagrece sem esforço", "health"],
  ])("blocks %s as unsupported (%s)", (text, reason) => {
    const check = verifyClaim(text, facts);
    expect(check).toMatchObject({ verdict: "unsupported", reason });
    expect(forbiddenClaimReason(text)).toBe(reason);
  });

  it("marks a wrong price as contradicted, citing the price fact", () => {
    const check = verifyClaim("Leve por R$ 4.290", facts);
    expect(check).toMatchObject({ verdict: "contradicted", reason: "price_mismatch" });
    expect(check.sources).toEqual([{ factKey: "current_price", sourceUrl: url }]);
  });

  it("marks free shipping as contradicted when the verified fact says false", () => {
    expect(verifyClaim("Frete grátis para todo o Brasil", facts)).toMatchObject({
      verdict: "contradicted",
      reason: "free_shipping_false",
    });
  });

  it("marks a discount as contradicted when the list price is not above the current price", () => {
    const flat = [fact("current_price", brl(4290)), fact("list_price", brl(4290))];
    expect(verifyClaim("Em promoção hoje", flat)).toMatchObject({
      verdict: "contradicted",
      reason: "discount_not_real",
    });
  });

  it("supports a claim that states its cited fact, with the source", () => {
    expect(verifyClaim("Por R$ 42,90", facts, "current_price")).toEqual({
      text: "Por R$ 42,90",
      verdict: "supported",
      reason: "fact_referenced",
      sources: [{ factKey: "current_price", sourceUrl: url }],
    });
    expect(verifyClaim("Mais de 10 mil vendidos", facts, "sold_quantity").verdict).toBe(
      "supported",
    );
    expect(verifyClaim("Vendido pela Casa Bonita", facts, "seller").verdict).toBe("supported");
    expect(verifyClaim("Muito bem avaliado", facts, "rating_average").verdict).toBe("supported");
  });

  it("does not accept a valid fact key as proof when the text says something else", () => {
    expect(verifyClaim("Cabe 20 pares de sapato", facts, "seller")).toMatchObject({
      verdict: "unverifiable",
      reason: "fact_not_referenced",
    });
    expect(verifyClaim("Super prático", facts, "current_price").reason).toBe("fact_not_referenced");
    expect(verifyClaim("Por R$ 42,90", facts, "missing_key").reason).toBe("fact_unknown");
  });

  it("lets opinions through as subjective and flags plain product statements as unverifiable", () => {
    expect(verifyClaim("Prático e bonito na lavanderia", facts)).toMatchObject({
      verdict: "subjective",
    });
    expect(forbiddenClaimReason("Prático e bonito na lavanderia")).toBeNull();
    expect(verifyClaim("Cabe 20 pares de sapato", facts)).toMatchObject({
      verdict: "unverifiable",
      reason: "no_evidence",
    });
    expect(forbiddenClaimReason("Cabe 20 pares de sapato")).toBeNull();
  });

  it("supports backed numbers without a fact key and keeps ordinary copy unblocked", () => {
    expect(verifyClaim("De R$ 59,90 por R$ 42,90", facts)).toMatchObject({
      verdict: "supported",
      reason: "numbers_backed",
    });
    for (const text of [
      "Organize a lavanderia sem gastar muito",
      "Melhor custo-benefício que encontramos",
      "Garantia do fabricante descrita no anúncio",
      "Usa pouco espaço no armário",
      "Frete não incluso.",
      "Comente QUERO que te envio o link no Direct",
    ])
      expect(forbiddenClaimReason(text)).toBeNull();
    expect(verifyClaim("Frete não incluso.", facts).verdict).not.toBe("contradicted");
  });
});

describe("copyClaimProblems", () => {
  it("lets the listing's own quality words through and flags invented ones", () => {
    expect(
      copyClaimProblems(["Estante resistente."], facts, "Estante Resistente 3 Prateleiras"),
    ).toEqual([]);
    expect(copyClaimProblems(["Estante resistente."], facts, "Estante 3 Prateleiras")).toEqual([
      "quality:Estante resistente.",
    ]);
  });
});
