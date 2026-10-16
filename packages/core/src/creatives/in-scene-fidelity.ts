import type { CommercialFact } from "../offers/offer.js";

/**
 * Automatic product fidelity gate for AI-drawn in-scene products (owner decision 2026-10-06).
 * The VLM only reports observations; this module decides. A failing deterministic check BLOCKs,
 * a missing answer is REVIEW, and the VLM can never approve on its own: PASS also needs the
 * colour check. Pure; pixel work for the colour evidence lives in providers.
 */
export type InSceneVerdict = "pass" | "block" | "review";

/** One table for every weight and threshold, so calibration is a single edit. */
export const IN_SCENE_FIDELITY_THRESHOLDS = Object.freeze({
  /** A reference colour only counts as "dominant" when it covers this share of the product. */
  dominantMinShare: 0.15,
  /** Each dominant reference colour must cover at least this share of the scene's pixels. */
  scenePresenceMin: 0.005,
  /** Colour distance (euclidean RGB) under which a scene pixel matches a reference colour. */
  colourDistance: 48,
  /** How many dominant colours the provider extracts from the cutout. */
  dominantColours: 3,
});

export type VisualFeature = Readonly<{ key: string; value: number }>;
export type ProductVisualSpec = Readonly<{
  features: readonly VisualFeature[];
  forbiddenMutations: readonly string[];
  /** Furniture: anything but the floor under it is a drawing error (standsOnFloor). */
  standsOnFloor?: boolean;
  /**
   * Parts sit around an axis (a rotating spice rack): one view shows only some of them, so a
   * count above the real one blocks and a count under it is not evidence of a wrong product.
   */
  partsAroundAxis?: boolean;
  /** Materials the title or a verified fact names, in English for the scene prompt. */
  materials?: readonly string[];
  /** Where each counted feature and material came from (brief 11.2: no detail without evidence). */
  evidence?: readonly SpecEvidence[];
}>;
export type SpecEvidence = Readonly<{ field: string; value: string; source: string }>;

/** The gate will count parts, so the shots must keep the product whole and uncovered. */
export const isCountCritical = (spec: Pick<ProductVisualSpec, "features">): boolean =>
  spec.features.length > 0;

const FORBIDDEN_MUTATIONS = Object.freeze([
  "invented text or logo on the product",
  "extra or missing parts",
  "different colour",
  "different product type",
]);

// Conservative pt-BR patterns: a number directly before the noun.
const FEATURE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["shelves", /(?<![\d.,])(\d{1,2})\s*prateleiras?\b/i],
  ["drawers", /(?<![\d.,])(\d{1,2})\s*gavetas?\b/i],
  ["pots", /(?<![\d.,])(\d{1,3})\s*potes?\b/i],
  ["pieces", /(?<![\d.,])(\d{1,3})\s*(?:pcs|pe[cç]as?|unidades?)(?![\p{L}])/iu],
];

// Named materials only (a word in the title or a verified fact); "stainless steel" before "metal".
const MATERIAL_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["stainless steel", /(?<!\p{L})inox(?!\p{L})/iu],
  ["metal", /(?<!\p{L})(?:a[cç]o|metal|met[aá]lic[oa]|ferro|aramad[oa])(?!\p{L})/iu],
  ["bamboo", /(?<!\p{L})bambu(?!\p{L})/iu],
  ["wood", /(?<!\p{L})(?:madeira|mdf|pinus)(?!\p{L})/iu],
  ["plastic", /(?<!\p{L})(?:pl[aá]stic[oa]|polipropileno)(?!\p{L})/iu],
  ["glass", /(?<!\p{L})vidro(?!\p{L})/iu],
  ["clear acrylic", /(?<!\p{L})acr[ií]lic[oa](?!\p{L})/iu],
  ["ceramic", /(?<!\p{L})cer[aâ]mica(?!\p{L})/iu],
  ["silicone", /(?<!\p{L})silicone(?!\p{L})/iu],
];
const MAX_MATERIALS = 2;
// porta-tempero 2026-10-09: a rotating 12-pot rack shows 6 to 8 pots from any side.
const AROUND_AXIS = /(?<!\p{L})(?:girat[oó]ri[oa]s?|rotativ[oa]s?|360)(?!\p{L})/iu;

export const productVisualSpecFor = (
  offerTitle: string,
  facts: readonly CommercialFact[] = [],
): ProductVisualSpec => {
  const sources: readonly (readonly [text: string, source: string])[] = [
    [offerTitle, "title"],
    ...facts.flatMap((fact) =>
      fact.verified && typeof fact.value === "string"
        ? [[fact.value, `fact:${fact.key}`] as const]
        : [],
    ),
  ];
  const features: VisualFeature[] = [];
  const materials: string[] = [];
  const evidence: SpecEvidence[] = [];
  for (const [key, pattern] of FEATURE_PATTERNS)
    for (const [text, source] of sources) {
      const match = pattern.exec(text);
      const value = match?.[1] ? Number(match[1]) : 0;
      if (value > 0) {
        features.push({ key, value });
        evidence.push({ field: `count:${key}`, value: String(value), source });
        break;
      }
    }
  for (const [name, pattern] of MATERIAL_PATTERNS) {
    if (materials.length >= MAX_MATERIALS) break;
    // Stainless steel already says metal.
    if (name === "metal" && materials.includes("stainless steel")) continue;
    const hit = sources.find(([text]) => pattern.test(text));
    if (!hit) continue;
    materials.push(name);
    evidence.push({ field: "material", value: name, source: hit[1] });
  }
  const aroundAxis = features.length > 0 && AROUND_AXIS.test(offerTitle);
  if (aroundAxis) evidence.push({ field: "parts_around_axis", value: "true", source: "title" });
  return {
    features,
    forbiddenMutations: FORBIDDEN_MUTATIONS,
    ...(standsOnFloor(offerTitle) ? { standsOnFloor: true } : {}),
    ...(aroundAxis ? { partsAroundAxis: true } : {}),
    ...(materials.length ? { materials } : {}),
    ...(evidence.length ? { evidence } : {}),
  };
};

/**
 * Where the VLM sees faces, people and the product, so text can be laid out around them.
 * Qwen3-VL grounding convention: `[x0, y0, x1, y1]`, integers normalized to 0..1000 of the
 * image width and height, origin top-left (independent of the image's pixel size).
 */
export type SubjectKind = "face" | "person" | "product";
export type SubjectBox = Readonly<{
  kind: SubjectKind;
  box: readonly [x0: number, y0: number, x1: number, y1: number];
}>;
export const MAX_SUBJECTS = 8;
const SUBJECT_KINDS: readonly string[] = ["face", "person", "product"];

/** Strict: the whole list is valid (ints 0..1000, x0 < x1, y0 < y1, <= 8) or it is null. */
export const parseSubjectBoxes = (value: unknown): readonly SubjectBox[] | null => {
  if (!Array.isArray(value) || value.length > MAX_SUBJECTS) return null;
  const subjects: SubjectBox[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const { kind, box, ...rest } = entry as Record<string, unknown>;
    if (Object.keys(rest).length > 0 || typeof kind !== "string" || !SUBJECT_KINDS.includes(kind))
      return null;
    if (!Array.isArray(box) || box.length !== 4) return null;
    if (!box.every((n) => Number.isInteger(n) && n >= 0 && n <= 1000)) return null;
    const [x0, y0, x1, y1] = box as [number, number, number, number];
    if (x0 >= x1 || y0 >= y1) return null;
    subjects.push({ kind: kind as SubjectKind, box: [x0, y0, x1, y1] });
  }
  return subjects;
};

export type VlmFidelityAnswer = Readonly<{
  productPresent: boolean;
  sameProductAsReference: boolean;
  counts: Readonly<Record<string, number | null>>;
  inventedTextOrLogo: boolean;
  notes: string;
  /** People visible in the scene (faces or bodies); optional in stored answers. */
  peopleCount?: number;
  /** Layout hint only: never read by `judgeInSceneFidelity`. */
  subjects?: readonly SubjectBox[];
  /** Scene-only question (vlmPlacementPrompt): what the product rests on. */
  placement?: Readonly<{ restingOn: RestingOn; note: string }>;
}>;

export const vlmFidelityJsonSchema = (spec: ProductVisualSpec) => ({
  type: "object",
  additionalProperties: false,
  required: [
    "productPresent",
    "sameProductAsReference",
    "counts",
    "inventedTextOrLogo",
    "notes",
    "peopleCount",
    "subjects",
  ],
  properties: {
    productPresent: { type: "boolean" },
    sameProductAsReference: { type: "boolean" },
    counts: {
      type: "object",
      additionalProperties: false,
      required: spec.features.map((feature) => feature.key),
      properties: Object.fromEntries(
        spec.features.map((feature) => [feature.key, { type: ["integer", "null"] }]),
      ),
    },
    inventedTextOrLogo: { type: "boolean" },
    notes: { type: "string", maxLength: 300 },
    peopleCount: { type: "integer", minimum: 0, maximum: MAX_SUBJECTS },
    subjects: {
      type: "array",
      maxItems: MAX_SUBJECTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "box"],
        properties: {
          kind: { enum: SUBJECT_KINDS },
          box: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: { type: "integer", minimum: 0, maximum: 1000 },
          },
        },
      },
    },
  },
});

/** Fixed prompt: image 1 is the reference product photo, image 2 is the generated scene. */
export const vlmFidelityPrompt = (spec: ProductVisualSpec): string =>
  [
    "You compare two images. Image 1 is the REFERENCE product photo. Image 2 is a generated illustration scene that should contain that same product.",
    "Judge only the product, never the person, the background or the art style.",
    "Answer with one JSON object and nothing else, matching this schema exactly:",
    JSON.stringify(vlmFidelityJsonSchema(spec)),
    "Rules:",
    "- productPresent: true only if the product from image 1 is visible in image 2.",
    "- sameProductAsReference: true only if it is the same product: same type, shape, colour and parts. Say false if anything differs.",
    spec.features.length > 0
      ? `- counts: count in image 2 the visible items for these keys (${spec.features
          .map((feature) => feature.key)
          .join(", ")}); use null when you cannot count them reliably.`
      : "- counts: an empty object.",
    "- inventedTextOrLogo: true if any text, letters, numbers or logo appear on the product in image 2 that are not in image 1.",
    "- peopleCount: how many different people are visible in image 2 (count each face or body once; a hand alone counts as one person).",
    "- notes: at most one short sentence naming the difference, or an empty string.",
    `- subjects: up to ${MAX_SUBJECTS} boxes in image 2, one per visible face (kind "face"), whole person (kind "person") and the product (kind "product"). box is [x0, y0, x1, y1]: integers from 0 to 1000 relative to the width and height of image 2, top-left origin, x0 < x1 and y0 < y1.`,
  ].join("\n");

const COUNT_WORDING: Readonly<Record<string, string>> = {
  shelves:
    "every horizontal board of the shelving product from the top one to the bottom one, the bottom board included",
  drawers: "every drawer front of the product, each counted once",
};

/**
 * Counting is asked on the scene alone, after the comparison: with the reference photo in the
 * same request the judge copies the reference count (desktop probe 2026-10-09: 3/6 right with
 * the reference, 6/6 on the scene alone).
 */
export const vlmCountPrompt = (key: string): string =>
  `Count the ${key} of the product in this image: ${
    COUNT_WORDING[key] ??
    `every separate ${key.replace(/s$/, "")} of the product, each counted once`
  }. Use null when you cannot count them reliably. Answer with one JSON object and nothing else: {"${key}": n}.`;

export const RESTING_ON = [
  "floor",
  "counter_or_table",
  "shelf",
  "held",
  "floating",
  "other",
] as const;
export type RestingOn = (typeof RESTING_ON)[number];

/** Products that stand on the floor: anywhere else is a drawing error (owner review 2026-10-09). */
const FLOOR_STANDING =
  /\b(estantes?|racks?|arm[aá]rios?|c[oô]modas?|sapateiras?|cabideiros?|mesas?|cadeiras?|bancos?|varais|varal|guarda-roupas?|criado-mudo|poltronas?|sof[aá]s?)\b/i;
export const standsOnFloor = (offerTitle: string): boolean => FLOOR_STANDING.test(offerTitle);

/**
 * Owner review 2026-10-09: a rack drawn on a kitchen table, another not standing on the floor.
 * Asked on the scene alone, naming the product so the judge does not pick a pot or a towel.
 * First wording ("is it supported?") said yes to the rack on the table (probe 17/18, the one
 * miss); this one asks what it rests on and core decides. Verdict "review" until calibrated.
 */
export const vlmPlacementPrompt = (offerTitle: string): string =>
  `The product in this illustration is: "${offerTitle.replace(/"/g, "'").slice(0, 120)}". Ignore the other objects. What is the product itself resting on? floor (its feet or base on the floor), counter_or_table (on a counter, table, desk or washing machine), shelf, held (in someone's hands), floating (no contact with any surface, or sunk into one), other. Answer with one JSON object and nothing else: {"restingOn": "...", "note": "one short sentence"}.`;

export const vlmPlacementJsonSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["restingOn", "note"],
  properties: {
    restingOn: { enum: [...RESTING_ON] },
    note: { type: "string", maxLength: 200 },
  },
});

/**
 * Reference photo selection (brief 11.1): listing photos are often collages or styled scenes
 * (2026-10-09: a three-view collage, a kitchen shot with text and props), which corrupt the
 * colour evidence, the cut-out and the composite. Asked on the photo alone.
 */
export const REFERENCE_EXTRAS = [
  "inset_photos",
  "text_or_badges",
  "props",
  "people",
  "other_products",
] as const;
export type ReferenceCheck = Readonly<{ clean: boolean; extras: readonly string[] }>;
export const vlmReferencePrompt = (offerTitle: string): string =>
  `This is a shop listing photo for: "${offerTitle.replace(/"/g, "'").slice(0, 120)}". Is it a clean product photo: the product alone and whole on a plain background, nothing else in the frame? List everything else you see: inset_photos (smaller pictures or panels inside the image), text_or_badges (words, numbers, labels, stickers, icons), props (other objects, food, plants, furniture, decoration), people (any person or body part), other_products (a second copy, size or variant of the product). Answer with one JSON object and nothing else: {"cleanProduct": true or false, "extras": [...], "note": "one short sentence"}.`;
export const vlmReferenceJsonSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["cleanProduct", "extras", "note"],
  properties: {
    cleanProduct: { type: "boolean" },
    extras: { type: "array", maxItems: 5, items: { enum: [...REFERENCE_EXTRAS] } },
    note: { type: "string", maxLength: 200 },
  },
});
/** Strict: a clean photo says so and lists nothing else; anything malformed is null. */
export const parseReferenceAnswer = (value: unknown): ReferenceCheck | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { cleanProduct, extras } = value as { cleanProduct?: unknown; extras?: unknown };
  if (typeof cleanProduct !== "boolean" || !Array.isArray(extras)) return null;
  const known: readonly string[] = REFERENCE_EXTRAS;
  if (!extras.every((entry) => typeof entry === "string" && known.includes(entry))) return null;
  const list = [...new Set(extras as string[])];
  return { clean: cleanProduct && list.length === 0, extras: list };
};

export const vlmCountJsonSchema = (key: string) => ({
  type: "object",
  additionalProperties: false,
  required: [key],
  properties: { [key]: { type: ["integer", "null"], minimum: 0, maximum: 1000 } },
});

/**
 * Strict parser: anything that is not exactly the schema is rejected, never repaired. `subjects`
 * is optional (older stored answers lack it) and is a layout hint only: an invalid list is
 * dropped as a whole without touching the fidelity fields, so boxes never change the verdict.
 */
export const parseVlmFidelityAnswer = (
  value: unknown,
  spec: ProductVisualSpec,
): VlmFidelityAnswer | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const keys = [
    "productPresent",
    "sameProductAsReference",
    "counts",
    "inventedTextOrLogo",
    "notes",
  ];
  const optional = ["subjects", "peopleCount", "placement"].filter((key) => key in raw).length;
  if (Object.keys(raw).length !== keys.length + optional || !keys.every((key) => key in raw))
    return null;
  const people = raw.peopleCount;
  if (
    people !== undefined &&
    !(Number.isInteger(people) && (people as number) >= 0 && (people as number) <= MAX_SUBJECTS)
  )
    return null;
  if (
    typeof raw.productPresent !== "boolean" ||
    typeof raw.sameProductAsReference !== "boolean" ||
    typeof raw.inventedTextOrLogo !== "boolean" ||
    typeof raw.notes !== "string" ||
    raw.notes.length > 300
  )
    return null;
  const counts = raw.counts;
  if (typeof counts !== "object" || counts === null || Array.isArray(counts)) return null;
  const expected = spec.features.map((feature) => feature.key);
  const got = Object.keys(counts);
  if (got.length !== expected.length || !expected.every((key) => got.includes(key))) return null;
  for (const entry of Object.values(counts))
    if (entry !== null && !(Number.isInteger(entry) && (entry as number) >= 0)) return null;
  const subjects = "subjects" in raw ? parseSubjectBoxes(raw.subjects) : null;
  const placement = parsePlacement(raw.placement);
  return {
    productPresent: raw.productPresent,
    sameProductAsReference: raw.sameProductAsReference,
    counts: counts as Record<string, number | null>,
    inventedTextOrLogo: raw.inventedTextOrLogo,
    notes: raw.notes,
    ...(people !== undefined ? { peopleCount: people as number } : {}),
    ...(subjects ? { subjects } : {}),
    ...(placement ? { placement } : {}),
  };
};

/** A malformed placement answer is dropped (review stays unaffected), never fails the parse. */
const parsePlacement = (value: unknown): VlmFidelityAnswer["placement"] | null => {
  if (typeof value !== "object" || value === null) return null;
  const { restingOn, note } = value as Record<string, unknown>;
  return (RESTING_ON as readonly unknown[]).includes(restingOn) &&
    typeof note === "string" &&
    note.length <= 200
    ? { restingOn: restingOn as RestingOn, note }
    : null;
};

/** Subject boxes stored with a scene's `inSceneFidelity` (under `vlm`); absent when malformed. */
export const storedSubjectBoxes = (inSceneFidelity: unknown): readonly SubjectBox[] | undefined => {
  const vlm = (inSceneFidelity as { vlm?: { subjects?: unknown } } | null | undefined)?.vlm;
  return parseSubjectBoxes(vlm?.subjects) ?? undefined;
};

/**
 * Evidence from the provider: each dominant colour of the reference cutout (alpha-aware) with its
 * share of the product, and the share of scene pixels close to it.
 */
export type ColourEvidence = readonly Readonly<{
  productShare: number;
  scenePresence: number;
}>[];

export const colourCheckPasses = (evidence: ColourEvidence): boolean =>
  evidence.every(
    (colour) =>
      colour.productShare < IN_SCENE_FIDELITY_THRESHOLDS.dominantMinShare ||
      colour.scenePresence >= IN_SCENE_FIDELITY_THRESHOLDS.scenePresenceMin,
  );

export type InSceneJudgement = Readonly<{
  verdict: InSceneVerdict;
  reasons: readonly string[];
}>;

export const judgeInSceneFidelity = (input: {
  spec: ProductVisualSpec;
  vlm?: VlmFidelityAnswer | undefined;
  colour?: ColourEvidence | undefined;
  expectedPeople?: 0 | 1;
}): InSceneJudgement => {
  const block: string[] = [];
  const review: string[] = [];
  if (input.colour) {
    if (!colourCheckPasses(input.colour)) block.push("colour_mismatch");
  } else review.push("colour_unchecked");
  if (input.vlm) {
    const vlm = input.vlm;
    if (!vlm.productPresent) block.push("product_absent");
    if (!vlm.sameProductAsReference) block.push("product_differs_from_reference");
    if (vlm.inventedTextOrLogo) block.push("invented_text_or_logo");
    for (const feature of input.spec.features) {
      const seen = vlm.counts[feature.key];
      if (seen === undefined || seen === null) review.push(`count_unknown:${feature.key}`);
      else if (input.spec.partsAroundAxis && seen < feature.value) {
        // Hidden behind the axis, not missing; a third or less visible is still worth a look.
        if (seen * 3 <= feature.value) review.push(`count_low:${feature.key}`);
      } else if (seen !== feature.value) block.push(`count_mismatch:${feature.key}`);
    }
    if (input.expectedPeople !== undefined) {
      if (vlm.peopleCount === undefined) review.push("people_unknown");
      else if (vlm.peopleCount > input.expectedPeople) block.push("extra_person");
    }
    if (vlm.placement) {
      const on = vlm.placement.restingOn;
      if (on === "floating") review.push("placement_floating");
      else if (input.spec.standsOnFloor && on !== "floor" && on !== "held")
        review.push(`placement_off_floor:${on}`);
    }
  } else review.push("vlm_unavailable");
  if (block.length > 0) return { verdict: "block", reasons: block };
  if (review.length > 0) return { verdict: "review", reasons: review };
  return { verdict: "pass", reasons: [] };
};

/** Reads `{ vlm, colour? }` stored in the scene asset metadata; anything malformed counts as absent. */
export const parseStoredInSceneFidelity = (
  value: unknown,
  spec: ProductVisualSpec,
): { vlm?: VlmFidelityAnswer; colour?: ColourEvidence } => {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as { vlm?: unknown; colour?: unknown };
  const vlm = parseVlmFidelityAnswer(raw.vlm, spec) ?? undefined;
  const colour =
    Array.isArray(raw.colour) &&
    raw.colour.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { productShare?: unknown }).productShare === "number" &&
        typeof (entry as { scenePresence?: unknown }).scenePresence === "number",
    )
      ? (raw.colour as ColourEvidence)
      : undefined;
  return { ...(vlm ? { vlm } : {}), ...(colour ? { colour } : {}) };
};
