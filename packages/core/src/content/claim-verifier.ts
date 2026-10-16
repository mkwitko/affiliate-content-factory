import type { CommercialFact } from "../offers/offer.js";
import { numbersWithoutEvidence } from "./preview-content.js";

/**
 * Classifies one piece of commercial copy against the offer's facts. A valid fact key is not proof:
 * the text must state that fact. Deterministic pt-BR rules; numbers stay with
 * `numbersWithoutEvidence`, which this reuses. `unsupported` and `contradicted` must never be
 * published; `subjective` is opinion; `unverifiable` is a product statement no fact covers.
 */
export type ClaimVerdict =
  | "supported"
  | "subjective"
  | "unsupported"
  | "contradicted"
  | "unverifiable";

export type ClaimCheck = Readonly<{
  text: string;
  verdict: ClaimVerdict;
  reason: string;
  sources: readonly Readonly<{ factKey: string; sourceUrl: string }>[];
}>;

const normalize = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR");

/** Claims no marketplace fact can back: never invented by copy. Matched on normalized text. */
const FORBIDDEN: readonly (readonly [reason: string, pattern: RegExp])[] = [
  [
    "testimonial",
    /\b(?:eu\s+)?(?:testei|usei|amei|aprovei|adorei|comprei)\b|\beu\s+uso\b|\buso\s+(?:ha|todo|todos|faz)\b|\bminha\s+experiencia\b|\b(?:clientes|compradores|consumidores|todo mundo|as pessoas)\s+(?:amam|adoram|aprovam|recomendam|estao comprando)\b|\b(?:dermatologistas?|especialistas?|medicos?|nutricionistas?)\s+(?:recomendam|aprovam|indicam)\b|\brecomendad[oa] por\b/,
  ],
  [
    "certification",
    /\bdermatologicamente\s+testad|\b(?:anvisa|inmetro)\b|\bcertificad|\bhipoalergenic|\bclinicamente\s+(?:testad|comprovad)|\btestad[oa] em laboratorio\b|\bcientificamente\s+comprovad|\bcomprovad[oa]\s+cientificamente\b/,
  ],
  [
    "guarantee",
    /\bgarantid[oa]s?\b|\bnunca\s+(?:mais\s+)?(?:quebra|estraga|enferruja|desbota|falha|vaza)\b|\bdura(?:r)?\s+(?:para sempre|a vida toda|anos)\b|\bindestrutive(?:l|is)\b|\b100\s?%\s+(?:eficaz|eficiente|seguro)\b/,
  ],
  [
    "ranking",
    /\bmelhor\s+(?:\p{L}+\s+)?d[oa]\s+(?:mercado|brasil|mundo|categoria)\b|\b(?:numero|n[oº°])\s*1\b|\blider\s+(?:de|do|da|em)\b|\bmais\s+vendid[oa]s?\s+d[oa]\b/u,
  ],
  [
    "health",
    /\bcura(?:r)?\b|\bemagrec|\belimina\s+(?:as\s+)?(?:rugas|celulite|estrias|manchas|acne|gordura|espinhas)\b|\btrata\s+(?:a\s+)?(?:acne|queda|calvicie|dermatite|psoriase)\b/,
  ],
];

/** Quality adjectives no marketplace fact backs; allowed only when the offer title itself says them. */
const QUALITY =
  /\b(?:resistentes?|duravel|duraveis|durabilidade|alta qualidade|qualidade superior|premium)\b/g;

const OPINION =
  /\b(?:pratic|bonit|lind|elegant|charmos|confortave|facil|faceis|facilita|ajuda|ideal|perfeit|otim|incrive|vale a pena|custo.beneficio|macio|delicad|modern|estilos|versat)/;
// A free-shipping promise; "frete não incluso" states the opposite and is not one.
const SHIPPING =
  /\bfrete\s+(?:gratis|gratuito|free|incluso)\b|\b(?:entrega|envio)\s+(?:gratis|gratuit[oa])\b|\bsem\s+(?:custo de\s+)?frete\b/;
const DISCOUNT = /\b(?:desconto|promocao|oferta relampago)\b|\boff\b/;
const PRICE = /R\$\s?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{2}))?(?!\d)/g;

/** The reason a text must never be published, whatever the facts; null when none applies. */
export const forbiddenClaimReason = (text: string, offerTitle?: string): string | null => {
  const normalized = normalize(text);
  const fixed = FORBIDDEN.find(([, pattern]) => pattern.test(normalized))?.[0];
  if (fixed) return fixed;
  const title = normalize(offerTitle ?? "");
  return [...normalized.matchAll(QUALITY)].some(([word]) => !title.includes(word))
    ? "quality"
    : null;
};

const isMoney = (value: unknown): value is { amountMinor: number } =>
  typeof value === "object" && value !== null && "amountMinor" in value;

const pricesIn = (text: string): number[] =>
  [...text.matchAll(PRICE)].map(
    (match) => Number((match[1] ?? "").replace(/\./g, "")) * 100 + Number(match[2] ?? 0),
  );

const NUMBER_NOUNS: Readonly<Record<string, RegExp>> = {
  sold_quantity: /vendid|vendas/,
  review_count: /avalia|opini/,
  available_quantity: /unidade|estoque/,
  discount_percent: /%|desconto|\boff\b/,
};

/** Does the text state this fact (not merely carry its key)? */
const states = (fact: CommercialFact, text: string): boolean => {
  const normalized = normalize(text);
  const { value } = fact;
  if (isMoney(value)) return pricesIn(text).includes(value.amountMinor);
  if (typeof value === "boolean")
    return fact.key === "free_shipping" && value && SHIPPING.test(normalized);
  if (typeof value === "number") {
    if (fact.key === "rating_average")
      return /\d/.test(text)
        ? /nota|estrela|media|★|⭐/.test(normalized)
        : value >= 4.5 && /avaliad/.test(normalized);
    const noun = NUMBER_NOUNS[fact.key];
    return noun ? /\d/.test(text) && noun.test(normalized) : normalized.includes(String(value));
  }
  if (fact.key === "availability" || fact.key === "listing_status")
    return /dispon|estoque|ativ/.test(normalized);
  return normalize(value)
    .split(/[^\p{L}\p{N}]+/u)
    .some((token) => token.length >= 4 && normalized.includes(token));
};

const source = (fact: CommercialFact) => ({ factKey: fact.key, sourceUrl: fact.sourceUrl });

export const verifyClaim = (
  text: string,
  facts: readonly CommercialFact[],
  factKey?: string,
  offerTitle?: string,
): ClaimCheck => {
  const verified = facts.filter((fact) => fact.verified);
  const find = (key: string) => verified.find((fact) => fact.key === key);
  const result = (
    verdict: ClaimVerdict,
    reason: string,
    cited: readonly CommercialFact[] = [],
  ) => ({
    text,
    verdict,
    reason,
    sources: cited.map(source),
  });
  const normalized = normalize(text);
  const forbidden = forbiddenClaimReason(text, offerTitle);
  if (forbidden) return result("unsupported", forbidden);

  const shipping = find("free_shipping");
  if (SHIPPING.test(normalized)) {
    if (!shipping) return result("unsupported", "shipping_unverified");
    if (shipping.value !== true) return result("contradicted", "free_shipping_false", [shipping]);
  }
  const current = find("current_price");
  const list = find("list_price");
  if (DISCOUNT.test(normalized)) {
    if (!current || !list || !isMoney(current.value) || !isMoney(list.value))
      return result("unsupported", "discount_unverified");
    if (list.value.amountMinor <= current.value.amountMinor)
      return result("contradicted", "discount_not_real", [current, list]);
  }
  const unbacked = numbersWithoutEvidence(text, verified);
  if (unbacked.length > 0)
    return unbacked.some((number) => number.startsWith("R$")) && current
      ? result("contradicted", "price_mismatch", [current])
      : result("unsupported", "number_without_evidence");

  if (factKey !== undefined) {
    const cited = find(factKey);
    if (!cited) return result("unverifiable", "fact_unknown");
    return states(cited, text)
      ? result("supported", "fact_referenced", [cited])
      : result("unverifiable", "fact_not_referenced");
  }
  const stated = verified.filter((fact) => states(fact, text));
  if (/\d/.test(text) && stated.length > 0) return result("supported", "numbers_backed", stated);
  if (OPINION.test(normalized)) return result("subjective", "opinion");
  return result("unverifiable", "no_evidence");
};

// pt-BR sentence ends (. ! ? …) or line breaks.
const SENTENCES = /(?<=[.!?…])\s+|\n+/;

/** Every sentence of the texts that must not be published, as `reason:sentence`. */
export const copyClaimProblems = (
  texts: readonly string[],
  facts: readonly CommercialFact[],
  /** Words the listing title itself uses (e.g. "resistente") are not invented quality claims. */
  offerTitle?: string,
): string[] =>
  texts
    .flatMap((text) => text.split(SENTENCES))
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => verifyClaim(sentence, facts, undefined, offerTitle))
    .filter((check) => check.verdict === "unsupported" || check.verdict === "contradicted")
    .map((check) => `${check.reason}:${check.text}`);
