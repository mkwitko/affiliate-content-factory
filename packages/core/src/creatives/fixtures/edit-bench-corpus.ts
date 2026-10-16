import { SCENE_COMPOSITION } from "../offer-scenes.js";

/**
 * Reference-edit bench corpus: the REAL product photo plus a recurring character sheet go into a
 * scene. Exact text is never drawn by the model; the renderer overlays it later. Reference ids
 * are public asset ids in the production workspace (character sheet first, product photo second).
 */
export type EditBenchCase = Readonly<{
  id: string;
  width: number;
  height: number;
  /** Asset ids, in the order the prompt names them: character sheet, then product photo. */
  references: readonly [string, string];
  prompt: string;
}>;

const FEED = { width: 768, height: 960 } as const;
const STORY = { width: 768, height: 1344 } as const;

export const STYLE =
  "Flat vector illustration in the same style as the character sheet. No text, no letters, no numbers, no logos anywhere in the image.";
export const PRODUCT =
  "The product from the second reference image, unchanged: same shape, same colour, same number of parts.";
export const PERSON = "The person from the first reference image, same face, hair and clothes";

export const CARLA = "be5cd8e0-1d3d-46a1-8e32-455c2c1774f8";
export const BIA = "c859fc97-893b-4a4d-8b66-6c1aaca8d300";
export const RAFA = "a74c1c5e-9d49-4150-8276-4248a86e9284";

const casa = (action: string) =>
  `${PERSON} (Carla, 35, curly brown hair in a bun, sage-green t-shirt). ${PRODUCT} A black plastic 3-shelf open rack, exactly as in the second reference image. Scene: small bathroom in a rented apartment, late afternoon light, palette sage green, beige and warm white. ${action} ${STYLE}`;
const beleza = (action: string) =>
  `${PERSON} (Bia, 28, straight dark-brown shoulder-length hair, sand-pink t-shirt). ${PRODUCT} A transparent acrylic makeup organizer with drawers. Scene: tiny shared bathroom counter, soft morning light, palette sand pink, off-white and gold. ${action} ${STYLE}`;
const tech = (action: string) =>
  `${PERSON} (Rafa, 30, short coily hair, short beard, thin glasses, graphite tee under a denim jacket). ${PRODUCT} Black wireless TWS earbuds with a charging case. Scene: home office, afternoon window light, palette graphite, blue-grey and cyan. ${action} ${STYLE}`;

const CASES: readonly EditBenchCase[] = Object.freeze([
  {
    id: "casa_feed",
    ...FEED,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla is placing towels, shampoo and toilet paper on the rack beside the shower.",
    ),
  },
  {
    id: "casa_story",
    ...STORY,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla looks relieved: the bathroom is now tidy, with the rack beside the shower.",
    ),
  },
  {
    id: "beleza_feed",
    ...FEED,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza("Bia is organizing her makeup into the organizer on the small counter."),
  },
  {
    id: "beleza_story",
    ...STORY,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza("Bia is picking a lipstick from the organizer, calm and ready for work."),
  },
  {
    id: "tech_feed",
    ...FEED,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech("Rafa is in a video call wearing the earbuds, his phone left on the desk."),
  },
  {
    id: "tech_story",
    ...STORY,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech("Rafa is opening the charging case on the desk."),
  },
  {
    id: "casa_problem",
    ...FEED,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla stands in the cluttered bathroom, towels and shampoo bottles piled on the sink, looking frustrated; the rack is not in the scene yet.",
    ),
  },
  {
    id: "casa_result",
    ...FEED,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla smiles, happy, next to the rack now full of neatly folded towels and bottles.",
    ),
  },
  {
    id: "beleza_problem",
    ...FEED,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza(
      "Bia searches through a messy pile of makeup on the counter, looking frustrated; the organizer is not in the scene yet.",
    ),
  },
  {
    id: "beleza_result",
    ...FEED,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza(
      "Bia smiles, happy, beside the organizer with her makeup neatly sorted in the drawers.",
    ),
  },
  {
    id: "tech_problem",
    ...FEED,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech(
      "Rafa is annoyed, a tangled wired headset pulling his phone off the desk during a video call; the earbuds are not in the scene yet.",
    ),
  },
  {
    id: "tech_result",
    ...FEED,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech(
      "Rafa smiles, happy, wearing the earbuds, walking freely around the home office, the charging case on the desk.",
    ),
  },
  // Reel story beats 2 and 3: the problem gets worse, then the character finds the product.
  {
    id: "casa_problem2",
    ...FEED,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla looks exasperated as towels and shampoo bottles slide off the crowded sink onto the floor; the rack is not in the scene yet.",
    ),
  },
  {
    id: "casa_discovery",
    ...FEED,
    references: [CARLA, "4e630393-95b1-4482-85e1-9fcbf739f916"],
    prompt: casa(
      "Carla finds the empty rack standing beside the shower and looks at it with a curious, hopeful smile.",
    ),
  },
  {
    id: "beleza_problem2",
    ...FEED,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza(
      "Bia, late for work, bends to pick up a lipstick that rolled off the crowded counter onto the floor, looking stressed; the organizer is not in the scene yet.",
    ),
  },
  {
    id: "beleza_discovery",
    ...FEED,
    references: [BIA, "449f380f-5813-43f2-86ce-8fe2954c41f4"],
    prompt: beleza(
      "Bia finds the empty organizer on the counter beside her makeup pile and looks at it with a curious, hopeful smile.",
    ),
  },
  {
    id: "tech_problem2",
    ...FEED,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech(
      "Rafa crouches to pick his phone up from the floor, the wired headset cable tangled around the chair, the video call still open on the laptop; the earbuds are not in the scene yet.",
    ),
  },
  {
    id: "tech_discovery",
    ...FEED,
    references: [RAFA, "2a5c0538-d4f6-42a3-8f56-42e66aa77019"],
    prompt: tech(
      "Rafa holds the open charging case at his desk and looks at the earbuds with a curious, hopeful smile.",
    ),
  },
]);

/** Same composition clause as production scenes, so the bench leaves room for the text too. */
export const EDIT_BENCH_CORPUS: readonly EditBenchCase[] = Object.freeze(
  CASES.map((item) => ({
    ...item,
    prompt: `${item.prompt} ${SCENE_COMPOSITION[item.height > item.width * 1.5 ? "story" : "feed"]}`,
  })),
);

/** Verified listing titles of the product photos above, keyed by product asset id. */
export const EDIT_BENCH_PRODUCT_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "4e630393-95b1-4482-85e1-9fcbf739f916":
    "Estante Plástica 3 Prateleiras Multiuso Organização Casa Lavanderia Banheiro Cozinha",
  "449f380f-5813-43f2-86ce-8fe2954c41f4":
    "Organizador Maquiagem Caixa Acrílico Transparente Portátil",
  "2a5c0538-d4f6-42a3-8f56-42e66aa77019": "Fone Ouvido Sem Fio Tws Bluetooth 5.3, Fone Ouvido",
});
