import { createHash } from "node:crypto";
import type { Asset } from "../assets/asset.js";
import { type AffiliateCharacterBible, affiliateBibleClause } from "./affiliate-character-bible.js";
import type { ProductVisualSpec } from "./in-scene-fidelity.js";

/**
 * Auto-package in-scene art (plan 2026-10-06, D1/D2): one FLUX.2 Klein scene per feed slide plus
 * one story scene for the cover, each drawn from [character sheet, product photo] and checked by
 * the automatic fidelity gate before it is usable. Pure; the task glue lives in home-worker.
 */
export type OfferSceneCanvas = "feed" | "story";
export const OFFER_SCENE_SIZE: Readonly<
  Record<OfferSceneCanvas, Readonly<{ width: number; height: number }>>
> = Object.freeze({ feed: { width: 512, height: 640 }, story: { width: 512, height: 896 } });
/** The first attempt plus two regenerations; then the item falls back to the cut-out render. */
export const MAX_OFFER_SCENE_ATTEMPTS = 3;
/** Extra attempts a slot can get from reviewer rejections (reject-scene.ts). */
export const MAX_OWNER_SCENE_REJECTIONS = 2;
/** Bump when the compiled prompt changes so stored scenes and seeds from older prompts miss. */
export const OFFER_SCENE_PROMPT_VERSION = 2;
export const OFFER_SCENE_STYLE =
  "flat vector illustration matching the first reference image, clean line, soft shading, no text, no letters, no logos";

/**
 * Room for the overlay text (owner feedback 2026-10-06: text covered faces). The feed overlay
 * puts the headline in the upper third; story keeps its top and bottom bands for text and UI.
 */
/** What a backdrop scene shows: bare floor and wall where the real product will be composited. */
export const BACKDROP_LINE =
  "An empty corner of the room seen straight on: bare floor across the lower half, a plain wall behind, soft daylight.";

export const SCENE_COMPOSITION: Readonly<Record<OfferSceneCanvas, string>> = Object.freeze({
  feed: "Composition: characters and product in the lower two thirds, upper third is calm plain background (wall/window), no faces in the upper third.",
  story:
    "Composition: keep the top 25% and bottom 25% calm plain background, characters and product in the middle.",
});

export type OfferSceneSlot = Readonly<{ slideIndex: number; canvas: OfferSceneCanvas }>;
export const slotKey = (slot: OfferSceneSlot): string => `${slot.slideIndex}:${slot.canvas}`;
/** Every feed slide, plus the cover on the story canvas. */
export const offerSceneSlots = (slideCount: number): readonly OfferSceneSlot[] => [
  ...Array.from({ length: slideCount }, (_, i) => ({ slideIndex: i + 1, canvas: "feed" as const })),
  ...(slideCount > 0 ? [{ slideIndex: 1, canvas: "story" as const }] : []),
];

/** Deterministic per item + slot + attempt, inside the sd.cpp seed range. */
export const offerSceneSeed = (contentItemId: string, slot: OfferSceneSlot, attempt: number) =>
  createHash("sha256")
    .update(`${contentItemId}:${slotKey(slot)}:${attempt}:v${OFFER_SCENE_PROMPT_VERSION}`)
    .digest()
    .readUInt32BE(0) % 2_147_483_647;

// ------------------------------------------------------------------ colour names

type Rgb = readonly [number, number, number];
/** A plain colour word for an sRGB colour (HSL buckets); good enough to steer a prompt. */
export const colourName = ([r, g, b]: Rgb): string => {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l < 0.16) return "black";
  if (s < 0.15) return l > 0.85 ? "white" : l > 0.6 ? "light grey" : l > 0.3 ? "grey" : "dark grey";
  if (l > 0.93) return "white";
  const h =
    d === 0
      ? 0
      : max === rn
        ? (((gn - bn) / d) % 6) * 60
        : max === gn
          ? ((bn - rn) / d + 2) * 60
          : ((rn - gn) / d + 4) * 60;
  const hue = (h + 360) % 360;
  if (hue < 15 || hue >= 330) return l > 0.7 ? "pink" : l < 0.3 ? "dark red" : "red";
  if (hue < 45) {
    if (l > 0.7 && s < 0.6) return "beige";
    return l < 0.45 ? "brown" : "orange";
  }
  if (hue < 70) return l > 0.75 && s < 0.6 ? "beige" : l < 0.35 ? "olive" : "yellow";
  if (hue < 165) return l < 0.3 ? "dark green" : "green";
  if (hue < 200) return "teal";
  if (hue < 255) return l < 0.3 ? "navy blue" : "blue";
  if (hue < 290) return "purple";
  return "pink";
};

// ------------------------------------------------------------------ prompt

const FEATURE_NOUN: Readonly<Record<string, string>> = Object.freeze({
  shelves: "shelves",
  drawers: "drawers",
  pots: "pots",
  pieces: "pieces",
});

/** Prices, percentages and decimals never reach the image model: it must not draw numbers. */
export const stripPrices = (text: string): string =>
  text
    .replace(/R\$\s*\d[\d.,]*/gi, " ")
    .replace(/\d[\d.,]*\s*%/g, " ")
    .replace(/\b\d+[.,]\d+\b/g, " ")
    .replace(/\breais\b/gi, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max).trim() : text);
const productNameFrom = (title: string): string =>
  clip(
    stripPrices(title)
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .slice(0, 8)
      .join(" "),
    80,
  );

export type OfferScenePromptInput = Readonly<{
  canvas: OfferSceneCanvas;
  storyWorld?: string | undefined;
  character: Readonly<{
    name: string;
    description: string;
    /** Parsed affiliate bible (parseAffiliateBible); absent keeps the free-text prompt. */
    bible?: AffiliateCharacterBible | null | undefined;
  }>;
  /** Wanted expression/pose; the bible's allowed lists win over these. */
  expression?: string | undefined;
  pose?: string | undefined;
  moment: Readonly<{ headline: string; body?: string | undefined }>;
  /**
   * Art direction for this slot (scene-direction.ts): the shot's line replaces the copy moment
   * and `people` says whether the character is drawn at all. Absent keeps the copy-as-moment
   * prompt, which always draws the character.
   */
  direction?:
    | Readonly<{
        line: string;
        people: 0 | 1;
        /**
         * Real-composite slot (Phase 3): the image model draws only the empty place; the real
         * product cut-out is composited afterwards, so the prompt never asks for the product.
         */
        backdrop?: boolean | undefined;
      }>
    | undefined;
  offerTitle: string;
  spec: ProductVisualSpec;
  colourNames: readonly string[];
}>;

/** How many people a compiled prompt asks for; the fidelity gate blocks anything above it. */
export const expectedPeopleFor = (input: Pick<OfferScenePromptInput, "direction">): 0 | 1 =>
  input.direction?.people ?? 1;

/**
 * The compiled scene prompt, modelled on the edit-bench corpus. Product wording comes only from
 * the offer title, the verified counted features and materials, and the measured dominant colours; the slide
 * copy is the moment, never text to draw. References: [character sheet, product photo].
 */
export const compileOfferScenePrompt = (input: OfferScenePromptInput): string => {
  const features = input.spec.features
    .filter((feature) => FEATURE_NOUN[feature.key])
    .map((feature) => `${feature.value} ${FEATURE_NOUN[feature.key]}`);
  const colours = [...new Set(input.colourNames)].slice(0, 3);
  const materials = input.spec.materials ?? [];
  const product = [
    productNameFrom(input.offerTitle),
    ...(materials.length ? [`made of ${materials.join(" and ")}`] : []),
    ...(colours.length ? [`main colours ${colours.join(" and ")}`] : []),
    ...(features.length ? [`with exactly ${features.join(" and ")}`] : []),
  ].join(", ");
  const moment = clip(
    stripPrices([input.moment.headline, input.moment.body ?? ""].join(". ").replace(/\.\s*$/, "")),
    240,
  );
  const world = input.storyWorld ? clip(stripPrices(input.storyWorld), 400) : "";
  const productSentence = `The product from the second reference image, unchanged: same shape, same colour, same number of parts (${product}).`;
  const tail = [SCENE_COMPOSITION[input.canvas], `Style: ${OFFER_SCENE_STYLE}.`];
  const direction = input.direction;
  if (direction?.backdrop)
    return [
      "The first reference image is only a style guide: do not draw its person.",
      "Do not draw the product from the second reference image; leave the spot where it would stand empty.",
      ...(world ? [`Scene: ${world}.`] : []),
      BACKDROP_LINE,
      "No people, no hands, no furniture or objects in the centre.",
      ...tail,
    ].join(" ");
  if (direction?.people === 0)
    // Product-only shot (arena slideSceneCaseFromReal): the sheet is a style reference, never a
    // person to draw, so a drawn person is an extra person for the gate.
    return [
      "The first reference image is only a style guide: do not draw its person.",
      productSentence,
      ...(world ? [`Scene: ${world}.`] : []),
      `${clip(stripPrices(direction.line), 300)} No people, no hands.`,
      ...tail,
    ].join(" ");
  return [
    `The person from the first reference image, same face, hair and clothes (${clip(input.character.name, 60)}: ${clip(stripPrices(input.character.description), 300)}).`,
    productSentence,
    ...(input.character.bible ? [affiliateBibleClause(input.character.bible, input)] : []),
    ...(world ? [`Scene: ${world}.`] : []),
    direction
      ? `${clip(stripPrices(direction.line), 300)} Exactly one person, ${clip(input.character.name, 60)}. No other people, no duplicates, no reflections.`
      : `Moment, shown only through action and expression, never as written words: ${moment}.`,
    ...tail,
  ].join(" ");
};

// ------------------------------------------------------------------ progress

/** Fidelity reasons that say the drawn product is wrong (not the people or the placement). */
const PRODUCT_FAILURE =
  /^(product_differs_from_reference|colour_mismatch|count_mismatch:|invented_text_or_logo)/;
export const productFailed = (reasons: readonly string[]): boolean =>
  reasons.some((reason) => PRODUCT_FAILURE.test(reason));

export type OfferSceneMetadata = Readonly<{
  contentItemId: string;
  slideIndex: number;
  canvas: OfferSceneCanvas;
  attempt: number;
}>;
export const offerSceneMetadata = (asset: Asset): OfferSceneMetadata | null => {
  const meta = asset.metadata ?? {};
  const { contentItemId, slideIndex, canvas, attempt } = meta as Record<string, unknown>;
  if (
    meta.role !== "offer_scene" ||
    typeof contentItemId !== "string" ||
    typeof slideIndex !== "number" ||
    (canvas !== "feed" && canvas !== "story") ||
    typeof attempt !== "number"
  )
    return null;
  return { contentItemId, slideIndex, canvas, attempt };
};
const passed = (asset: Asset): boolean =>
  asset.state === "active" &&
  (asset.metadata?.inSceneFidelity as { verdict?: unknown } | undefined)?.verdict === "pass";

export type OfferSceneProgress = Readonly<{
  /** slotKey -> the passing scene's asset id. */
  passed: ReadonlyMap<string, string>;
  /** Scenes stored and waiting for their fidelity check. */
  pending: readonly Asset[];
  /**
   * Slots to draw next, with their attempt number, in slot order, and why the slot's latest
   * attempt failed (empty on the first attempt).
   */
  needed: readonly Readonly<{
    slot: OfferSceneSlot;
    attempt: number;
    previousReasons: readonly string[];
  }>[];
  /** Slots that failed every allowed attempt: the item falls back to the cut-out render. */
  exhausted: readonly OfferSceneSlot[];
  complete: boolean;
}>;

export const offerSceneProgress = (
  slots: readonly OfferSceneSlot[],
  scenes: readonly Asset[],
): OfferSceneProgress => {
  const passedBySlot = new Map<string, string>();
  const pending: Asset[] = [];
  const needed: OfferSceneProgress["needed"][number][] = [];
  const exhausted: OfferSceneSlot[] = [];
  for (const slot of slots) {
    const mine = scenes.filter((asset) => {
      const meta = offerSceneMetadata(asset);
      return meta && slotKey(meta) === slotKey(slot);
    });
    const win = mine.find(passed);
    if (win) {
      passedBySlot.set(slotKey(slot), win.id);
      continue;
    }
    const waiting = mine.filter((asset) => asset.state === "pending");
    if (waiting.length > 0) {
      pending.push(...waiting);
      continue;
    }
    const attempts = Math.max(0, ...mine.map((asset) => offerSceneMetadata(asset)?.attempt ?? 0));
    // A reviewer's rejection (reject-scene.ts) grants the slot one attempt beyond the budget.
    const ownerRejected = Math.min(
      MAX_OWNER_SCENE_REJECTIONS,
      mine.filter((asset) => asset.metadata?.ownerRejection).length,
    );
    if (attempts - ownerRejected >= MAX_OFFER_SCENE_ATTEMPTS) exhausted.push(slot);
    else {
      const last = mine.find((asset) => offerSceneMetadata(asset)?.attempt === attempts);
      const record = (last?.metadata?.ownerRejection ?? last?.metadata?.inSceneFidelity) as
        | { reasons?: unknown }
        | undefined;
      const reasons = record?.reasons;
      needed.push({
        slot,
        attempt: attempts + 1,
        previousReasons: Array.isArray(reasons)
          ? reasons.filter((entry): entry is string => typeof entry === "string")
          : [],
      });
    }
  }
  return {
    passed: passedBySlot,
    pending,
    needed,
    exhausted,
    complete: slots.length > 0 && passedBySlot.size === slots.length,
  };
};
