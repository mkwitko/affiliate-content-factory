import type { ClaimKind } from "../../../content/editorial.js";
import type { ExplainerCharacter } from "../../explainer-context.js";
import type { MotionSceneTiming } from "../../motion/plan.js";
import { NARRATION_WORD, type SceneSpec } from "../../scene-spec.js";

/**
 * Style-frame fixtures (video slice 13, spec v2 section 9): the 10 mandatory frames, the 2
 * optional ones and the 6-second motion test, as deterministic SceneSpec shots the harness
 * renders per candidate. Narration is pt-BR because the review judges caption legibility on a
 * phone for the real audience. Every shot is a one-scene storyboard at render time; together, in
 * this order, the shots also form one storyboard that `validateSceneSpecs` accepts (test).
 */
export const STYLE_FRAME_LANGUAGE = "pt-BR";
export const STYLE_FRAME_CAPTION_WORDS = 3 as const;

export const STYLE_FRAME_CAST: readonly ExplainerCharacter[] = [
  {
    key: "alex",
    name: "Alex",
    role: "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
    wardrobe: {
      hair: { style: "short", colour: "#2b1d12" },
      top: { style: "hoodie", colour: "#2f6fdb" },
      bottoms: { style: "pants", colour: "#333333" },
    },
  },
  {
    key: "bia",
    name: "Bia",
    role: "secondary",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffe9d6", accent: "#2f7de1" },
    accessory: "glasses",
    wardrobe: {
      hair: { style: "long", colour: "#6b3e26" },
      top: { style: "shirt", colour: "#f2c14e" },
      bottoms: { style: "skirt", colour: "#3d405b" },
    },
  },
  {
    key: "rafa",
    name: "Rafa",
    role: "secondary",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: { line: "#161616", fill: "#ffffff", accent: "#2a9d8f" },
    accessory: "cap",
    wardrobe: {
      hair: { style: "curly", colour: "#111111" },
      top: { style: "tshirt", colour: "#e07a5f" },
      bottoms: { style: "shorts", colour: "#264653" },
    },
  },
];

/** The chart frame draws numbers, so it cites a verified fact (fixture claim 0). */
export const STYLE_FRAME_CLAIMS: readonly Readonly<{ kind: ClaimKind }>[] = [
  { kind: "verified_fact" },
];

export type StyleFrameGrade = "night" | "warm";

export type StyleFrameShot = Readonly<{
  /** Frame number of spec section 9 (1-12) or 0 for the motion test. */
  frame: number;
  /** `<frame>-<slug>`; file names derive from it. */
  id: string;
  title: string;
  /** What the owner judges on this frame (spec section 30 wording). */
  judge: string;
  optional?: boolean;
  /** Narration of the shot; word anchors and captions come from it. */
  text: string;
  /** When the still is taken, ms into the shot. */
  atMs: number;
  /** Shot length; the motion test is the only long one. */
  durationMs: number;
  /** Harness-only plate grade for the night and warm variants of one location (experiment only). */
  grade?: StyleFrameGrade;
  scene: Omit<SceneSpec, "index" | "fromChar" | "toChar">;
}>;

const base = { props: [], overlays: [], captionMode: "word" } as const;
const STILL_MS = 3_200;
const AT = 1_400;

export const STYLE_FRAME_SHOTS: readonly StyleFrameShot[] = [
  {
    frame: 1,
    id: "01-character-model-front",
    title: "Character model: front",
    judge: "The same character recognisable front, side, wide and close.",
    text: "Esse aqui é o Alex e ele vai te explicar tudo",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "hook",
      background: "plain",
      actors: [
        { characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" },
      ],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 1,
    id: "01-character-model-side",
    title: "Character model: side, walking (the rig has no three-quarter view: gap for slice 19)",
    judge: "The same character recognisable front, side, wide and close.",
    text: "Ele anda pelo mercado como qualquer pessoa",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "setup",
      background: "plain",
      actors: [
        {
          characterKey: "alex",
          pose: "walking",
          expression: "neutral",
          position: "center",
          facing: "right",
        },
      ],
      camera: { shot: "wide", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 1,
    id: "01-character-model-close",
    title: "Character model: close",
    judge: "The same character recognisable front, side, wide and close.",
    text: "E pensa antes de gastar",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "setup",
      background: "plain",
      actors: [
        { characterKey: "alex", pose: "thinking", expression: "neutral", position: "center" },
      ],
      camera: { shot: "close", movement: "none" },
      transition: "hard_cut",
    },
  },
  ...(
    [
      ["joy", "happy", "celebrating", "push_in", "Que alegria quando a conta fecha"],
      ["fear", "worried", "scared", "none", "Medo de olhar o extrato"],
      ["doubt", "skeptical", "thinking", "push_in", "Será que vale mesmo a pena"],
      ["anger", "angry", "neutral", "none", "Raiva de pagar juros de novo"],
      ["awe", "surprised", "surprised", "push_in", "Uau eu não sabia disso"],
      ["deadpan", "neutral", "neutral", "none", "Pois é ninguém sabe"],
    ] as const
  ).map(
    ([name, expression, pose, movement, text], i): StyleFrameShot => ({
      frame: 2,
      id: `02-expression-${name}`,
      title: `Expression sheet: ${name}`,
      judge: "Six expressions read at a glance on the same face.",
      text,
      atMs: AT,
      durationMs: STILL_MS,
      scene: {
        ...base,
        purpose: i % 2 === 0 ? "question" : "explanation",
        background: "plain",
        actors: [{ characterKey: "alex", pose, expression, position: "center" }],
        camera: { shot: "close", movement },
        transition: "hard_cut",
      },
    }),
  ),
  {
    frame: 3,
    id: "03-establishing-wide",
    title: "Establishing wide: small hero, three depth layers (plate, props, actor)",
    judge: "Focal hierarchy obvious; one light direction; hero survives at 160x284.",
    text: "Todo mercado grande esconde o leite lá no fundo",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "setup",
      background: "store",
      actors: [
        {
          characterKey: "alex",
          pose: "walking",
          expression: "neutral",
          position: "left",
          scale: 0.7,
          facing: "right",
        },
      ],
      props: [
        { type: "shopping_cart", position: "right" },
        { type: "milk_carton", position: "center" },
      ],
      camera: { shot: "wide", movement: "slow_zoom_in" },
      transition: "fade",
    },
  },
  {
    frame: 4,
    id: "04-hero-prop-number-caption",
    title: "Hero + prop + hook number + caption",
    judge: "Number and caption legible on a phone; accent survives at 160x284.",
    text: "São quarenta e sete reais a mais por semana",
    atMs: 2_000,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "escalation",
      background: "store",
      actors: [
        { characterKey: "alex", pose: "holding_phone", expression: "surprised", position: "left" },
      ],
      props: [{ type: "phone", position: "right" }],
      overlays: [{ text: "R$ 47 / semana", position: "top", emphasis: true }],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 5,
    id: "05-insert",
    title: "Insert: object only",
    judge: "An insert without a character still reads as the same show.",
    text: "Olha o preço da caixinha",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "explanation",
      background: "store",
      actors: [],
      props: [{ type: "milk_carton", position: "center" }],
      camera: { shot: "close", movement: "push_in" },
      transition: "hard_cut",
    },
  },
  {
    frame: 6,
    id: "06-two-character-dialogue",
    title: "Two-character dialogue with blocking",
    judge: "Two-character blocking reads: who speaks, who listens.",
    text: "A Bia pergunta e o Alex responde na hora",
    atMs: 2_200,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "question",
      background: "office",
      actors: [
        {
          characterKey: "alex",
          pose: "pointing",
          expression: "happy",
          position: "left",
          facing: "right",
          actions: [
            {
              type: "look_at",
              atWord: 4,
              target: { kind: "actor", characterKey: "bia" },
              durationMs: 800,
            },
          ],
        },
        {
          characterKey: "bia",
          pose: "thinking",
          expression: "confused",
          position: "right",
          facing: "left",
        },
      ],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 7,
    id: "07-metaphor-no-characters",
    title: "Visual metaphor without characters",
    judge: "A frame with no character still belongs to the show.",
    text: "Antes um carrinho cheio depois uma lista curta",
    atMs: 2_400,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "explanation",
      background: "grid",
      actors: [],
      diagram: { kind: "before_after", before: "Carrinho cheio", after: "Lista curta" },
      camera: { shot: "wide", movement: "none" },
      transition: "wipe",
    },
  },
  {
    frame: 8,
    id: "08-night-tension",
    title: "Night or tension variant of frame 3's location",
    judge: "The same location recognisable at night; tension reads.",
    text: "De noite o mercado vazio parece outro lugar",
    atMs: AT,
    durationMs: STILL_MS,
    grade: "night",
    scene: {
      ...base,
      purpose: "escalation",
      background: "store",
      actors: [{ characterKey: "alex", pose: "scared", expression: "worried", position: "center" }],
      props: [{ type: "shopping_cart", position: "right" }],
      camera: { shot: "close", movement: "handheld" },
      transition: "hard_cut",
    },
  },
  {
    frame: 9,
    id: "09-warm-resolution",
    title: "Warm resolution in the same location",
    judge: "The same location recognisable; the resolution feels warm.",
    text: "No fim a lista curta salvou o mês",
    atMs: 2_400,
    durationMs: STILL_MS,
    grade: "warm",
    scene: {
      ...base,
      purpose: "payoff",
      background: "store",
      actors: [
        { characterKey: "alex", pose: "celebrating", expression: "happy", position: "left" },
        {
          characterKey: "bia",
          pose: "neutral",
          expression: "excited",
          position: "right",
          actions: [{ type: "react", atWord: 5, mark: "sparkle" }],
        },
      ],
      props: [{ type: "shopping_cart", position: "center" }],
      camera: { shot: "wide", movement: "slow_zoom_out" },
      transition: "fade",
    },
  },
  {
    frame: 10,
    id: "10-information-heavy-chart",
    title: "Information-heavy chart",
    judge: "Text-heavy frame legible; hierarchy holds.",
    text: "Compare o gasto por semana em cada loja da cidade",
    atMs: 2_600,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "explanation",
      background: "plain",
      actors: [
        {
          characterKey: "alex",
          pose: "pointing",
          expression: "neutral",
          position: "left",
          scale: 0.8,
        },
      ],
      diagram: {
        kind: "bar_compare",
        items: [
          { label: "Mercado A", value: 312, unit: "R$" },
          { label: "Mercado B", value: 268, unit: "R$" },
          { label: "Feira", value: 190, unit: "R$" },
          { label: "Atacado", value: 154, unit: "R$" },
        ],
        claimRef: 0,
      },
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 11,
    id: "11-crowd",
    title: "Crowd (optional)",
    judge: "Three characters stay distinct at wide.",
    optional: true,
    text: "Todo mundo na fila pensando a mesma coisa",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "loop",
      background: "street",
      actors: [
        { characterKey: "alex", pose: "neutral", expression: "neutral", position: "left" },
        { characterKey: "bia", pose: "holding_phone", expression: "skeptical", position: "center" },
        { characterKey: "rafa", pose: "typing", expression: "confused", position: "right" },
      ],
      camera: { shot: "wide", movement: "pan_left" },
      transition: "hard_cut",
    },
  },
  {
    frame: 12,
    id: "12-match-cut-a",
    title: "Match-cut pair: A (optional)",
    judge: "Same composition, different location: the cut lands.",
    optional: true,
    text: "Aqui no escritório a conta fecha",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "cta",
      background: "office",
      actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "center" }],
      props: [{ type: "laptop", position: "right" }],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 0,
    id: "00-motion-test",
    title: "Six-second motion test (static camera)",
    judge:
      "Motion feels animated, not interpolated: entrance, moving hold, gaze, point, settle, blink, caption on the spoken word.",
    text: "Olha só o que acontece quando você para de comprar por impulso todo mês",
    atMs: 3_600,
    durationMs: 6_000,
    scene: {
      ...base,
      purpose: "payoff",
      background: "kitchen",
      actors: [
        {
          characterKey: "alex",
          pose: "neutral",
          expression: "neutral",
          position: "center",
          actions: [
            { type: "enter", atWord: 0, from: "left", durationMs: 900 },
            { type: "look_at", atWord: 4, target: { kind: "prop", index: 0 }, durationMs: 500 },
            { type: "point_at", atWord: 7, target: { kind: "prop", index: 0 }, durationMs: 1_200 },
          ],
        },
      ],
      props: [{ type: "lightbulb", position: "right" }],
      camera: { shot: "wide", movement: "none" },
      transition: "hard_cut",
    },
  },
  {
    frame: 12,
    id: "12-match-cut-b",
    title: "Match-cut pair: B (optional)",
    judge: "Same composition, different location: the cut lands.",
    optional: true,
    text: "E no aeroporto também fecha",
    atMs: AT,
    durationMs: STILL_MS,
    scene: {
      ...base,
      purpose: "loop",
      background: "airport",
      actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "center" }],
      props: [{ type: "laptop", position: "right" }],
      camera: { shot: "medium", movement: "none" },
      transition: "hard_cut",
    },
  },
];

export const MOTION_TEST_ID = "00-motion-test";

/** The shots as one storyboard (contiguous narration), for `validateSceneSpecs` and tests. */
export const styleFrameStoryboard = (): Readonly<{
  scenes: readonly SceneSpec[];
  texts: readonly string[];
}> => {
  let cursor = 0;
  const scenes = STYLE_FRAME_SHOTS.map((shot, i): SceneSpec => {
    const fromChar = cursor;
    cursor += shot.text.length + (i < STYLE_FRAME_SHOTS.length - 1 ? 1 : 0);
    return { ...shot.scene, index: i + 1, fromChar, toChar: cursor };
  });
  return { scenes, texts: STYLE_FRAME_SHOTS.map((shot) => shot.text) };
};

const LEAD_IN_MS = 200;
const TAIL_MS = 300;

/** Even word timing over the shot, the same synthetic pacing as render-bench (no TTS needed). */
export const styleFrameTiming = (shot: StyleFrameShot): MotionSceneTiming => {
  const voiceStartMs = LEAD_IN_MS;
  const voiceMs = shot.durationMs - LEAD_IN_MS - TAIL_MS;
  const tokens = [...shot.text.matchAll(NARRATION_WORD)].map((match) => match[0]);
  const step = voiceMs / tokens.length;
  return {
    startMs: 0,
    endMs: shot.durationMs,
    voiceStartMs,
    voiceEndMs: voiceStartMs + voiceMs,
    text: shot.text,
    words: tokens.map((word, w) => ({
      text: word,
      startMs: Math.round(voiceStartMs + w * step),
      endMs: Math.round(voiceStartMs + (w + 1) * step - 40),
    })),
  };
};

/** One-scene SceneSpec for rendering a shot on its own. */
export const styleFrameScene = (shot: StyleFrameShot): SceneSpec => ({
  ...shot.scene,
  index: 1,
  fromChar: 0,
  toChar: shot.text.length,
});
