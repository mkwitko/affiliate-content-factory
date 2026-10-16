import type { CopyBenchCase } from "../content/fixtures/copy-bench-corpus.js";
import { buildOfferCopyInput, OFFER_COPY_CHANNELS } from "../content/offer-copy.js";
import {
  BIA,
  CARLA,
  PERSON,
  PRODUCT,
  RAFA,
  STYLE,
} from "../creatives/fixtures/edit-bench-corpus.js";
import {
  isCountCritical,
  productVisualSpecFor,
  standsOnFloor,
} from "../creatives/in-scene-fidelity.js";
import { BACKDROP_LINE, stripPrices } from "../creatives/offer-scenes.js";
import type { ArtDirectionInput, ArtDirectionSlide } from "../creatives/scene-direction.js";
import {
  REAL_PRODUCTS,
  type RealProduct,
  type RealProductNiche,
} from "./fixtures/real-products.js";

/**
 * Arena level 2 cases built from the real-product set: the same copy loop and the same scene
 * prompt style as production, with the product described only by its listing title (the
 * 2026-10-06 lesson: hand-written product wording drifts from the photo).
 */
const NICHE = {
  casa: {
    name: "Casa",
    editorialVoice: "Prática e direta, fala de rotina e organização",
    characterId: CARLA,
    characterName: "Carla",
    characterLook: "35, curly brown hair in a bun, sage-green t-shirt",
    person: `${PERSON} (Carla, 35, curly brown hair in a bun, sage-green t-shirt).`,
    scene:
      "Scene: small kitchen and laundry corner in a rented apartment, late afternoon light, palette sage green, beige and warm white.",
    action:
      "Carla is using the product in her daily routine, the product clearly visible and in focus.",
  },
  beleza: {
    name: "Beleza",
    editorialVoice: "Leve e cuidadosa, fala de rotina e praticidade",
    characterId: BIA,
    characterName: "Bia",
    characterLook: "28, straight dark-brown shoulder-length hair, sand-pink t-shirt",
    person: `${PERSON} (Bia, 28, straight dark-brown shoulder-length hair, sand-pink t-shirt).`,
    scene:
      "Scene: tiny shared bathroom counter, soft morning light, palette sand pink, off-white and gold.",
    action:
      "Bia is using the product while getting ready, the product clearly visible and in focus.",
  },
  tech: {
    name: "Tech",
    editorialVoice: "Objetiva e clara, sem jargão desnecessário",
    characterId: RAFA,
    characterName: "Rafa",
    characterLook:
      "30, short coily hair, short beard, thin glasses, graphite tee under a denim jacket",
    person: `${PERSON} (Rafa, 30, short coily hair, short beard, thin glasses, graphite tee under a denim jacket).`,
    scene: "Scene: home office, afternoon window light, palette graphite, blue-grey and cyan.",
    action: "Rafa is using the product at his desk, the product clearly visible and in focus.",
  },
} as const satisfies Record<RealProductNiche, unknown>;

export const copyCaseFromReal = (p: RealProduct): CopyBenchCase => ({
  id: p.id,
  niche: p.niche,
  facts: p.facts,
  sourceFactKeys: p.facts.map((f) => f.key),
  // The same packet production builds: the copy format is seeded by the product id.
  input: buildOfferCopyInput({
    title: p.title,
    facts: p.facts,
    voice: null,
    niche: {
      name: NICHE[p.niche].name,
      editorialVoice: NICHE[p.niche].editorialVoice,
      languages: ["pt-BR"],
    },
    channels: OFFER_COPY_CHANNELS,
    seed: p.id,
    characterName: NICHE[p.niche].characterName,
  }),
});

export type RealSceneCase = Readonly<{
  id: string;
  width: number;
  height: number;
  /** Character sheet asset id, then the product photo (mlstatic URL or `asset:<uuid>`). */
  references: readonly [string, string];
  prompt: string;
  product: RealProduct;
}>;

/** One feed scene (512x640, as the desktop renders before upscaling) per real product. */
/**
 * The product sentence. Colours are measured on the listing photo (production does the same), so
 * the niche palette cannot repaint the product: on 2026-10-08 a black rack came out sage green.
 */
const productPhrase = (p: RealProduct, colours: readonly string[]): string => {
  const unique = [...new Set(colours)].slice(0, 3);
  return `${PRODUCT} ${p.visual.charAt(0).toUpperCase()}${p.visual.slice(1)}${
    unique.length ? `, main colours ${unique.join(" and ")}` : ""
  }, exactly as in the second reference image. The room palette never changes the product's colours.`;
};

const sceneCase = (
  p: RealProduct,
  action: string,
  colours: readonly string[] = [],
): RealSceneCase => {
  const n = NICHE[p.niche];
  return {
    id: p.id,
    width: 512,
    height: 640,
    references: [n.characterId, p.photo],
    prompt: `${n.person} ${productPhrase(p, colours)} ${n.scene} ${action} ${STYLE}`,
    product: p,
  };
};

export const sceneCaseFromReal = (p: RealProduct): RealSceneCase =>
  sceneCase(p, NICHE[p.niche].action);

const CAST = ["Carla", "Bia", "Rafa"] as const;

export const artDirectionInputFromReal = (
  p: RealProduct,
  slides: readonly ArtDirectionSlide[],
): ArtDirectionInput => {
  const n = NICHE[p.niche];
  return {
    product: p.visual,
    character: { name: n.characterName, description: n.characterLook },
    otherNames: CAST.filter((name) => name !== n.characterName),
    world: n.scene.replace(/^Scene:\s*/, "").replace(/\.$/, ""),
    countCritical: isCountCritical(productVisualSpecFor(p.title)),
    onFloor: standsOnFloor(p.title),
    slides,
  };
};

/** The scene for one slide: its copy is the moment, as production draws it, never as text. */
export const slideSceneCaseFromReal = (
  p: RealProduct,
  moment: Readonly<{ headline: string; body?: string | undefined }>,
  direction?: Readonly<{ line: string; people: 0 | 1; backdrop?: boolean | undefined }>,
  /** colourName of the listing photo's dominant colours. */
  colours: readonly string[] = [],
): RealSceneCase => {
  if (!direction)
    return sceneCase(
      p,
      `Moment, shown only through action and expression, never as written words: ${stripPrices(
        [moment.headline, moment.body ?? ""].join(". ").replace(/\.\s*$/, ""),
      )}.`,
      colours,
    );
  const n = NICHE[p.niche];
  if (direction.people === 1)
    return sceneCase(
      p,
      `${direction.line} Exactly one person, ${n.characterName}. No other people, no duplicates, no reflections.`,
      colours,
    );
  // Product only: the character sheet stays as the style reference, never as a person to draw.
  const base = sceneCase(p, "", colours);
  // Composite slot (Phase 3): the backdrop alone; the real cut-out is composited afterwards.
  if (direction.backdrop)
    return {
      ...base,
      prompt: `The first reference image is only a style guide: do not draw its person. Do not draw the product from the second reference image; leave the spot where it would stand empty. ${n.scene} ${BACKDROP_LINE} No people, no hands, no furniture or objects in the centre. ${STYLE}`,
    };
  return {
    ...base,
    prompt: `The first reference image is only a style guide: do not draw its person. ${productPhrase(p, colours)} ${n.scene} ${direction.line} No people, no hands. ${STYLE}`,
  };
};

/** Interleaved niches so any prefix of the list covers casa, beleza and tech. */
export const realProductsInterleaved = (): readonly RealProduct[] => {
  const by = (niche: RealProductNiche) => REAL_PRODUCTS.filter((p) => p.niche === niche);
  const lists = [by("casa"), by("beleza"), by("tech")];
  const out: RealProduct[] = [];
  for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i += 1)
    for (const list of lists) if (list[i]) out.push(list[i] as RealProduct);
  return out;
};
