/**
 * Affiliate copy formats as data. One format is chosen per content item (deterministic, seeded by
 * the item id) and its beats and rules go into the copy packet and the copywriter prompt. This
 * is the editorial layer; the media format (carousel, reel...) stays with format-director.
 * Nothing here may ask for a demonstration, testimonial or comparison no listed fact backs.
 */
export const COPY_FORMAT_IDS = [
  "problema_do_dia",
  "antes_de_comprar",
  "achado_da_semana",
  "duvida_respondida",
  "mini_historia",
] as const;
export type CopyFormatId = (typeof COPY_FORMAT_IDS)[number];

export type CopyFormat = Readonly<{
  id: CopyFormatId;
  objective: string;
  /** One role per slide, in order; `beatsFor` drops the beats the packet cannot feed (3-6). */
  beats: readonly string[];
  rules: readonly string[];
  qaNotes: readonly string[];
  needsQuestions?: true;
  needsCharacter?: true;
}>;

const PRICE = "price moment: say {preco} once, plainly, with no urgency";
const CTA =
  "pointer to the listing: the one thing this kind of product needs checking there (compatibility for electronics, measures for furniture, shade or volume for beauty), no pressure";
const COMMON_RULES = [
  "Open with a concrete everyday situation or buyer question, never a catalogue phrase.",
  "Show the product in use only as a plain description of what it is for; never claim anyone tested or owns it.",
  "A detail comes from a listed fact or the title; if no fact covers a point, send the reader to the listing.",
  "No comparison with other products, no ranking, no testimonials, no quality adjectives the title does not say.",
  "Beats describe what each slide does; never copy them. Write only what the reader sees: never mention the title, the facts, the beats or these rules.",
] as const;

export const COPY_FORMATS: Readonly<Record<CopyFormatId, CopyFormat>> = {
  problema_do_dia: {
    id: "problema_do_dia",
    objective: "Name a small daily annoyance and show the product in place as the way out.",
    beats: [
      "hook situation: the daily scene, items in the wrong place",
      "pain: what is annoying about it, in one concrete detail",
      "product in use: where it sits and what goes on it",
      "concrete detail: one listed measure, count or material, written as a plain product detail",
      PRICE,
      CTA,
    ],
    rules: COMMON_RULES,
    qaNotes: ["The scene must be recognisable in one line.", "No before/after promise."],
  },
  antes_de_comprar: {
    id: "antes_de_comprar",
    objective: "Help the buyer decide fit before buying: what to measure and confirm.",
    beats: [
      "hook question: the doubt a buyer has before this kind of purchase",
      "pain: the usual mistake of buying without checking",
      "product in use: where it would go at home",
      "concrete detail: the listed dimension, count or version, as a plain product detail",
      PRICE,
      CTA,
    ],
    rules: [...COMMON_RULES, "Frame every point as something to check, not as a promise."],
    qaNotes: ["Honest tone: it is fine to say a fact is not listed."],
  },
  achado_da_semana: {
    id: "achado_da_semana",
    objective: "Present the product as a find for one specific situation, without superlatives.",
    beats: [
      "hook situation: who needs this and when",
      "pain: the gap it fills in that situation",
      "product in use: the plain description of its use",
      "concrete detail: one feature the listing states, as a plain product detail",
      PRICE,
      CTA,
    ],
    rules: [...COMMON_RULES, "Never say best, number one or most sold."],
    qaNotes: ["'Find' is about the situation, not about the product being rare."],
  },
  duvida_respondida: {
    id: "duvida_respondida",
    objective: "Answer one real buyer question using only listed facts, or point to the listing.",
    beats: [
      "hook question: a buyer question from the packet, paraphrased",
      "answer: only from listed facts; otherwise say to check the listing",
      "product in use: the situation behind the question",
      "concrete detail: a second listed detail, as a plain product detail",
      PRICE,
      CTA,
    ],
    rules: [...COMMON_RULES, "Paraphrase buyer questions; never quote them or copy their numbers."],
    qaNotes: ["Needs buyer questions in the packet."],
    needsQuestions: true,
  },
  mini_historia: {
    id: "mini_historia",
    objective: "A short story of the niche character with a small problem and a plain resolution.",
    beats: [
      "scene setup: the character in a concrete situation",
      "complication: the small problem, one detail",
      "product in use: the character puts the product to use (description, not a review)",
      "resolution: the situation is calmer; no promised result",
      PRICE,
      CTA,
    ],
    rules: [
      ...COMMON_RULES,
      "Use the character by name; the story is fiction, so no claims of results or feelings about quality.",
    ],
    qaNotes: ["Needs the niche main character."],
    needsCharacter: true,
  },
};

/**
 * The slide count follows the material (brief 8.2): a "pain" beat needs buyer complaints or
 * questions to paraphrase, a "concrete detail" beat needs a count, measure or version in the
 * title. Without them the model would have to invent, so the beat goes and the deck is shorter.
 */
export const beatsFor = (
  format: Pick<CopyFormat, "beats">,
  packet: Readonly<{ hasBuyerVoice: boolean; title: string }>,
): readonly string[] =>
  format.beats.filter(
    (beat) =>
      !(beat.startsWith("pain:") && !packet.hasBuyerVoice) &&
      !(beat.startsWith("concrete detail:") && !/\d/.test(packet.title)),
  );

/** FNV-1a: small, stable across runtimes (same as format-director). */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return value;
};

/** Same seed and conditions always give the same format; formats the packet cannot feed are skipped. */
export const selectCopyFormat = (input: {
  seed: string;
  hasQuestions: boolean;
  characterName?: string | undefined;
}): CopyFormat => {
  const eligible = COPY_FORMAT_IDS.map((id) => COPY_FORMATS[id]).filter(
    (format) =>
      (!format.needsQuestions || input.hasQuestions) &&
      (!format.needsCharacter || Boolean(input.characterName?.trim())),
  );
  return eligible[hash(input.seed) % eligible.length] as CopyFormat;
};
