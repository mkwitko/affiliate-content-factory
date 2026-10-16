import type { TemplateId } from "./templates.js";

/**
 * Art direction for offer scenes (spec 2026-10-08): each slide template gets a fixed shot, the
 * local copy model writes one concrete scene line per slide, and this module validates those
 * lines. A rejected or missing line falls back to the shot's default; nothing is repaired.
 */
export type Shot = Readonly<{
  kind:
    | "character_in_use"
    | "hands_feature"
    | "result"
    | "product_hero"
    | "product_feature"
    | "product_in_place";
  /** The most people the scene may show. */
  people: 0 | 1;
  /** What the shot shows, in the words the model sees. */
  direction: string;
}>;

const result: Shot = {
  kind: "result",
  people: 1,
  direction: "the result: the product in use and the problem solved",
};
const productHero: Shot = {
  kind: "product_hero",
  people: 0,
  direction:
    "product alone where it belongs (furniture on the floor, a small item on a counter), large and in focus, calm space above it, no people",
};

// Count-critical products: the whole product stays visible, nobody holds it, each slot differs.
const productFeature: Shot = {
  kind: "product_feature",
  people: 0,
  direction:
    "the product whole and in focus, just placed, its main feature plain to see, everyday items beside it, no people",
};
const productInPlace: Shot = {
  kind: "product_in_place",
  people: 0,
  direction:
    "the product in the place where it is used, loaded and organised with everyday items, the room around it, no people",
};

export const SHOT_FOR_TEMPLATE: Readonly<Record<TemplateId, Shot>> = Object.freeze({
  hero: {
    kind: "character_in_use",
    people: 1,
    direction: "the character using the product in the place where it is used",
  },
  benefit: {
    kind: "hands_feature",
    people: 1,
    direction: "close-up of the character's hands using the product's main feature",
  },
  proof: result,
  review: result,
  price: productHero,
  cta: productHero,
});

/**
 * The shot for a slide. A count-critical product (one whose title states a count the fidelity
 * gate checks: shelves, pots...) keeps the character only on the hero; the other slots show
 * the product alone, where the image model keeps the count (arena 2026-10-08: 4 and 5 shelves
 * drawn on character shots, 3 on product-only shots).
 */
export const shotFor = (
  slide: Readonly<{ index: number; template: TemplateId }>,
  countCritical: boolean,
): Shot => {
  const shot = SHOT_FOR_TEMPLATE[slide.template];
  if (!countCritical || slide.index === 1 || shot.people === 0) return shot;
  return shot.kind === "hands_feature" ? productFeature : productInPlace;
};

export type ArtDirectionSlide = Readonly<{
  index: number;
  template: TemplateId;
  headline: string;
  body?: string | undefined;
}>;
export type ArtDirectionInput = Readonly<{
  /** Short English product name for context; scene lines call it "the product". */
  product: string;
  character: Readonly<{ name: string; description: string }>;
  /** Names of the other recurring characters, never allowed in this product's scenes. */
  otherNames: readonly string[];
  /** The place and light of the niche story world, without a "Scene:" prefix. */
  world: string;
  /** Product-only shots after the hero (shotFor). */
  countCritical?: boolean | undefined;
  /**
   * Furniture that stands on the floor (standsOnFloor); anything else sits on a counter, table
   * or shelf and a line putting it on the floor is rejected (porta-tempero drawn on the floor,
   * 2026-10-09).
   */
  onFloor?: boolean | undefined;
  slides: readonly ArtDirectionSlide[];
}>;
export type SceneLine = Readonly<{
  index: number;
  line: string;
  source: "model" | "default";
  reason?: string;
}>;

export const defaultSceneLine = (
  shot: Shot,
  input: Pick<ArtDirectionInput, "character" | "world" | "onFloor">,
): string => {
  const name = input.character.name;
  const place = input.onFloor ? "on the floor" : "on a clean counter";
  switch (shot.kind) {
    case "character_in_use":
      return `${name} using the product in ${input.world}, the product large, fully visible and in focus.`;
    case "hands_feature":
      return `Close-up of ${name}'s hands using the product, the product sharp and filling the lower half of the frame.`;
    case "result":
      return `The product in use in ${input.world}, everything tidy, ${name} relaxed beside it.`;
    case "product_hero":
      return `The product alone ${place}, large, centred and in focus, soft shadow, nothing else around it.`;
    case "product_feature":
      return `The product just placed ${place}, whole and in focus, a few everyday items beside it waiting to go on.`;
    case "product_in_place":
      return `The product in ${input.world}, loaded and organised with everyday items, the room tidy around it.`;
  }
};

const TEXT_OR_PRICE =
  /R\$|\$|%|\b(reais|real|price|prices|discount|off|sale|text|sign|signs|logo|logos|label|labels|letters|words|caption|tag)\b/i;
const EXTRA_PEOPLE =
  /\b(people|persons|friends?|family|couple|crowd|customers?|guests?|children|kids?|baby|husband|wife|partner|mother|father|roommates?|someone|another (person|woman|man)|two (women|men|girls|boys|people)|mirror|reflections?)\b/i;
const ANY_PERSON = /\b(person|woman|man|girl|boy|hands?|she|he|her|his)\b/i;
const ON_FLOOR = /\b(on|onto|across) the (floor|ground|rug|carpet)\b/i;
const OFF_FLOOR =
  /\b(on|onto|atop) (a|the) (\w+ )?(counter|countertop|table|desk|shelf|bench|stool|bed|sink)\b/i;
const word = (name: string) => new RegExp(`\\b${name.replace(/[^\p{L}]/gu, "")}\\b`, "iu");

/** Why a scene line cannot be used for this shot, or null when it can. */
export const sceneLineProblem = (
  line: unknown,
  shot: Shot,
  input: ArtDirectionInput,
): string | null => {
  if (typeof line !== "string") return "not_string";
  const text = line.trim();
  if (text.length < 15 || text.length > 300) return "length";
  // Counts ("3 shelves", "12 jars") are product facts the production prompt states anyway
  // (arena 2026-10-08: a whole pipeline lost its lines to "3 shelves"); prices, decimals and
  // long numbers are what the image model must never be asked to draw.
  if (/\d[.,]\d|\d{3,}/.test(text)) return "digit";
  if (TEXT_OR_PRICE.test(text)) return "text_or_price";
  if (EXTRA_PEOPLE.test(text) || input.otherNames.some((name) => word(name).test(text)))
    return "extra_person";
  if (shot.people === 0 && (ANY_PERSON.test(text) || word(input.character.name).test(text)))
    return "person_on_product_shot";
  if (input.onFloor === false && ON_FLOOR.test(text)) return "on_floor";
  if (input.onFloor === true && OFF_FLOOR.test(text)) return "off_floor";
  return null;
};

/** One line per slide, in slide order; the first valid model line for an index wins. */
export const validateSceneLines = (
  raw: unknown,
  input: ArtDirectionInput,
): readonly SceneLine[] => {
  const entries =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { lines?: unknown }).lines)
      ? ((raw as { lines: unknown[] }).lines as unknown[])
      : [];
  const used = new Set<string>();
  return input.slides.map((slide) => {
    const shot = shotFor(slide, input.countCritical === true);
    const fallback = (reason: string): SceneLine => ({
      index: slide.index,
      line: defaultSceneLine(shot, input),
      source: "default",
      reason,
    });
    const candidates = entries.filter(
      (entry): entry is { index: number; scene: unknown } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { index?: unknown }).index === slide.index,
    );
    const first = candidates[0];
    if (!first) return fallback("missing");
    const problem = sceneLineProblem(first.scene, shot, input);
    if (problem) return fallback(problem);
    const line = (first.scene as string).trim();
    // The same line twice draws the same scene twice (arena 2026-10-09: three identical slides).
    if (used.has(line.toLowerCase())) return fallback("duplicate");
    used.add(line.toLowerCase());
    return { index: slide.index, line, source: "model" };
  });
};

export const artDirectionJsonSchema = (input: ArtDirectionInput) => ({
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      minItems: input.slides.length,
      maxItems: input.slides.length,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "scene"],
        properties: {
          index: { type: "integer", minimum: 1, maximum: input.slides.length },
          scene: { type: "string", maxLength: 300 },
        },
      },
    },
  },
});

const RULES = [
  "You are the art director of a Brazilian product carousel. For each slide write ONE scene line in English for an illustrator.",
  "A scene line is one concrete moment: who, doing what, with which everyday objects, where, and the product's state (empty, being placed, in use, organised). Follow the slide's story role: problem before the product, discovery, solved daily life, product alone.",
  "The product is the hero: fully visible, large and in focus, resting where it belongs, never floating. Call it only 'the product'. Never describe its parts, counts, colours or brand.",
  "Only the named character may appear, at most once. Never a second person, a crowd, a mirror or a reflection. Product-only slides have no people and no hands.",
  "Every slide is a different moment: never repeat a line or describe the same arrangement twice.",
  "Never mention text, numbers, prices, logos, labels, signs or screens.",
  "At most 45 words per line. Answer with JSON only.",
].join("\n");

export const buildArtDirectionMessages = (
  input: ArtDirectionInput,
): readonly Readonly<{ role: "system" | "user"; content: string }>[] => [
  { role: "system", content: RULES },
  {
    role: "user",
    content: [
      `Product: ${input.product}.`,
      input.onFloor === undefined
        ? "The product rests where it belongs: furniture on the floor, a small item on a counter or shelf."
        : input.onFloor
          ? "The product is furniture: it always stands on the floor, never on a counter or table."
          : "The product is small: it always sits on a counter, table or shelf, never on the floor.",
      `Character: ${input.character.name}, ${input.character.description}.`,
      `Place: ${input.world}.`,
      "Slides (Portuguese copy, for meaning only; never draw it):",
      ...input.slides.map((slide) => {
        const shot = shotFor(slide, input.countCritical === true);
        return `Slide ${slide.index} (${slide.template}): ${shot.direction}. Copy: "${slide.headline}${slide.body ? `. ${slide.body}` : ""}"`;
      }),
    ].join("\n"),
  },
];
