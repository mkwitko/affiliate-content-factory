import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import type { StagePosition } from "../explainer/layout.js";
import type { PropId } from "../explainer/props.js";
import type { SceneDirectorCatalog } from "../explainer/scene-director.js";
import {
  type ActorAction,
  collectSceneSpecIssues,
  MAX_PROPS,
  NARRATION_WORD,
  type SceneActor,
  type SceneSpec,
} from "../explainer/scene-spec.js";
import { literalExcerpt } from "./director-plan.js";
import type { ClaimKind, ScriptBeat } from "./editorial.js";

/**
 * Semantic intents (director v5). The model chooses scenes, cast, composition and mood; these
 * rules materialize what the narration states explicitly, deterministically:
 * - NARRATED_MOVEMENT: a named character walking or going to a place gets walk_to.
 * - NUMBER_EMPHASIS: a verified number the script calls attention to (an attention verb or a
 *   number_proof beat) gets a literal overlay the actor points at.
 * - SALIENT_PROP: catalog objects the narration names are shown, ranked by importance.
 * CLAIM_VISUALIZATION lives in the compiler (claimDiagram). Each change is kept only when the
 * storyboard validator reports no new problem; repeated pictures and cameras are left to the
 * visual normalizers that run next. Vocabulary is pt and en; other languages get no intents.
 */
export type DirectorIntentContext = Readonly<{
  body: string;
  language: string;
  claims: readonly Readonly<{ text: string; kind: ClaimKind }>[];
  beats: readonly ScriptBeat[];
  characters: readonly ExplainerCharacter[];
  catalog: SceneDirectorCatalog;
}>;

/** Whole-word, case-insensitive alternatives; \b does not see accented letters. */
const words = (alternatives: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");

const VOCABULARY = {
  pt: {
    move: words([
      "caminha",
      "caminhou",
      "anda",
      "andou",
      "vai",
      "foi",
      "corre",
      "correu",
      "segue",
      "seguiu",
      "atravessa",
      "atravessou",
      "volta",
      "voltou",
    ]),
    toward: /^\s+(?:[\p{L}\p{N}]+\s+){0,3}?(?:até|para|pra|pro|ao|à|aos|às|rumo)(?![\p{L}\p{N}])/iu,
    pronoun: words(["ele", "ela"]),
    attention: words(["olha", "olhe", "repara", "repare", "veja", "vê", "observe", "confira"]),
    handle: words([
      "pega",
      "pegou",
      "segura",
      "segurou",
      "abre",
      "abriu",
      "mostra",
      "mostrou",
      "liga",
      "ligou",
      "usa",
      "usou",
      "coloca",
      "colocou",
      "tira",
      "tirou",
      "troca",
      "trocou",
      "compra",
      "comprou",
      "guarda",
      "guardou",
      "deixa",
      "deixou",
    ]),
    props: {
      money_stack: ["dinheiro", "grana"],
      coin: ["moeda", "moedas"],
      phone: ["celular", "celulares", "telefone", "smartphone"],
      laptop: ["notebook", "notebooks", "laptop", "computador"],
      shopping_cart: ["carrinho", "carrinhos"],
      milk_carton: ["leite"],
      airplane: ["avião", "aviões"],
      clock: ["relógio", "relógios"],
      document: ["documento", "documentos", "contrato"],
      card: ["cartão", "cartões"],
      lightbulb: ["lâmpada", "lâmpadas"],
      globe: ["globo"],
      shield: ["escudo"],
    },
  },
  en: {
    move: words(["walks", "walked", "goes", "went", "runs", "ran", "heads", "headed", "moves"]),
    toward: /^\s+(?:[\p{L}\p{N}]+\s+){0,2}?(?:to|toward|towards|into)(?![\p{L}\p{N}])/iu,
    pronoun: words(["he", "she"]),
    attention: words(["look", "notice", "check"]),
    handle: words(["picks", "holds", "opens", "shows", "uses", "puts", "takes", "buys", "grabs"]),
    props: {
      money_stack: ["money", "cash"],
      coin: ["coin", "coins"],
      phone: ["phone", "phones", "smartphone"],
      laptop: ["laptop", "laptops", "notebook", "computer"],
      shopping_cart: ["cart", "carts"],
      milk_carton: ["milk"],
      airplane: ["airplane", "plane"],
      clock: ["clock", "watch"],
      document: ["document", "documents", "contract"],
      card: ["card", "cards"],
      lightbulb: ["lightbulb", "bulb", "bulbs"],
      globe: ["globe"],
      shield: ["shield"],
    },
  },
} satisfies Record<
  string,
  Readonly<{
    move: RegExp;
    toward: RegExp;
    pronoun: RegExp;
    attention: RegExp;
    handle: RegExp;
    props: Partial<Record<PropId, readonly string[]>>;
  }>
>;
type Vocabulary = (typeof VOCABULARY)["pt"] | (typeof VOCABULARY)["en"];

const NUMBER_TOKEN = /\d+(?:[.,]\d+)*/g;
const ARM_BUSY: readonly string[] = ["point_at", "pose", "enter", "exit", "walk_to", "jump"];
/** Mechanical rules the visual normalizers repair after this pass. */
const NORMALIZED_LATER = new Set(["repeated_scene", "camera_repeated"]);

const all = (pattern: RegExp, text: string) => [...text.matchAll(new RegExp(pattern))];
/** Sentences of a scene text with their offsets, split like scriptSegments (1.500 stays whole). */
const sentencesOf = (text: string) => {
  const sentences: { at: number; text: string }[] = [];
  let from = 0;
  for (const end of text.matchAll(/[.!?]+(?:\s+|$)/g)) {
    const to = end.index + end[0].length;
    sentences.push({ at: from, text: text.slice(from, to) });
    from = to;
  }
  if (from < text.length) sentences.push({ at: from, text: text.slice(from) });
  return sentences;
};
/** Index of the narration word that starts at or after `offset` (the word containing it). */
const wordAt = (text: string, offset: number): number =>
  all(NARRATION_WORD, text).filter((word) => word.index + word[0].length <= offset).length;

const withActor = (scene: SceneSpec, key: string, update: (actor: SceneActor) => SceneActor) => ({
  ...scene,
  actors: scene.actors.map((actor) => (actor.characterKey === key ? update(actor) : actor)),
});
/** The action alone, or after dropping the actor's arm and body moves it could overlap. */
const actionVariants = (scene: SceneSpec, key: string, action: ActorAction) => [
  withActor(scene, key, (actor) => ({ ...actor, actions: [...(actor.actions ?? []), action] })),
  withActor(scene, key, (actor) => ({
    ...actor,
    actions: [...(actor.actions ?? []).filter((a) => !ARM_BUSY.includes(a.type)), action],
  })),
  withActor(scene, key, (actor) => {
    const { motionTokens: _tokens, ...rest } = actor;
    return {
      ...rest,
      actions: [...(actor.actions ?? []).filter((a) => !ARM_BUSY.includes(a.type)), action],
    };
  }),
];

export const applyDirectorIntents = (
  scenes: readonly SceneSpec[],
  context: DirectorIntentContext,
): readonly SceneSpec[] => {
  const language = context.language.toLowerCase().slice(0, 2);
  const vocabulary: Vocabulary | undefined =
    language === "pt" ? VOCABULARY.pt : language === "en" ? VOCABULARY.en : undefined;
  if (!vocabulary) return scenes;
  const textOf = (scene: SceneSpec) => context.body.slice(scene.fromChar, scene.toChar);
  const problems = (board: readonly SceneSpec[]) =>
    collectSceneSpecIssues({
      scenes: board,
      characters: context.characters,
      claims: context.claims,
      renderer: "stickman_motion",
      language: context.language,
      sceneTexts: board.map(textOf),
    }).filter((issue) => !NORMALIZED_LATER.has(issue.code)).length;
  let board = [...scenes];
  /** Keeps the first candidate scene that adds no validator problem; reports whether one did. */
  const tryScenes = (index: number, candidates: readonly SceneSpec[]): boolean => {
    const before = problems(board);
    for (const candidate of candidates) {
      const next = board.map((scene, i) => (i === index ? candidate : scene));
      if (problems(next) <= before) {
        board = next;
        return true;
      }
    }
    return false;
  };
  const hasAction = (type: string) => (context.catalog.actions as readonly string[]).includes(type);

  // SALIENT_PROP
  const propWords = Object.entries(vocabulary.props).filter(([prop]) =>
    (context.catalog.props as readonly string[]).includes(prop),
  ) as [PropId, readonly string[]][];
  for (const [index] of scenes.entries()) {
    const scene = board[index];
    if (!scene) continue;
    const text = textOf(scene);
    const beatSentences = sentencesOf(text).filter((sentence) =>
      context.beats.some((beat) => {
        const at = beat.atChar - scene.fromChar;
        return at >= sentence.at && at < sentence.at + sentence.text.length;
      }),
    );
    const handled = all(vocabulary.handle, text).map((verb) => verb.index + verb[0].length);
    const ranked = propWords
      .flatMap(([prop, nouns]) =>
        all(words(nouns), text).map((match) => {
          const acted = handled.some(
            (end) => end <= match.index && wordAt(text, match.index) - wordAt(text, end) <= 2,
          );
          const inBeat = beatSentences.some(
            (sentence) =>
              match.index >= sentence.at && match.index < sentence.at + sentence.text.length,
          );
          return { prop, at: match.index, rank: acted ? 0 : inBeat ? 1 : 2 };
        }),
      )
      .sort((a, b) => a.rank - b.rank || a.at - b.at)
      .map(({ prop }) => prop)
      .filter((prop, i, list) => list.indexOf(prop) === i)
      .slice(0, MAX_PROPS);
    for (const prop of ranked) {
      const current = board[index];
      if (!current || current.props.some((own) => own.type === prop)) continue;
      const targeted = new Set(
        current.actors.flatMap((actor) =>
          [...(actor.actions ?? []), ...(actor.motionTokens ?? [])].flatMap((action) =>
            "target" in action && action.target?.kind === "prop" ? [action.target.index] : [],
          ),
        ),
      );
      const used = new Set<string>([
        ...current.props.map((own) => own.position),
        ...current.actors.map((actor) => actor.position),
      ]);
      const position =
        (["right", "left", "top", "center"] as const).find((spot) => !used.has(spot)) ?? "top";
      const replaceable = current.props.findIndex(
        (own, i) => !ranked.includes(own.type) && !targeted.has(i),
      );
      const candidate =
        current.props.length < MAX_PROPS
          ? { ...current, props: [...current.props, { type: prop, position }] }
          : replaceable >= 0
            ? {
                ...current,
                props: current.props.map((own, i) =>
                  i === replaceable ? { type: prop, position: own.position } : own,
                ),
              }
            : undefined;
      if (candidate) tryScenes(index, [candidate]);
    }
  }

  // NARRATED_MOVEMENT
  if (hasAction("walk_to"))
    for (const [index] of scenes.entries()) {
      const scene = board[index];
      if (!scene) continue;
      const text = textOf(scene);
      for (const sentence of sentencesOf(text))
        for (const verb of all(vocabulary.move, sentence.text)) {
          const after = sentence.text.slice(verb.index + verb[0].length);
          if (!vocabulary.toward.test(after)) continue;
          const before = sentence.text.slice(0, verb.index);
          const named = context.characters.find((character) =>
            words([character.name, character.key]).test(before),
          );
          const current = board[index];
          if (!current) continue;
          const key =
            named?.key ??
            (current.actors.length === 1 && all(vocabulary.pronoun, before).length > 0
              ? current.actors[0]?.characterKey
              : undefined);
          const actor = current.actors.find((entry) => entry.characterKey === key);
          if (!actor || actor.actions?.some((action) => action.type === "walk_to")) continue;
          const to: StagePosition =
            current.props
              .map((prop) => prop.position)
              .find((spot): spot is StagePosition => spot !== "top" && spot !== actor.position) ??
            (actor.position === "right" ? "left" : "right");
          const atWord = wordAt(text, sentence.at + verb.index);
          tryScenes(
            index,
            actionVariants(current, actor.characterKey, { type: "walk_to", atWord, to }),
          );
        }
    }

  // NUMBER_EMPHASIS
  const verified = context.claims.filter((claim) => claim.kind === "verified_fact");
  const isVerified = (token: string) =>
    verified.some((claim) => all(NUMBER_TOKEN, claim.text).some(([written]) => written === token));
  for (const [index] of scenes.entries()) {
    const scene = board[index];
    if (!scene) continue;
    const text = textOf(scene);
    const numbers = all(NUMBER_TOKEN, text).filter(([token]) => isVerified(token));
    const proof = context.beats.find(
      (beat) =>
        beat.label === "number_proof" &&
        beat.atChar >= scene.fromChar &&
        beat.atChar < scene.toChar,
    );
    const called = sentencesOf(text).flatMap((sentence) => {
      const verb = all(vocabulary.attention, sentence.text)[0];
      if (!verb) return [];
      const from = sentence.at + verb.index;
      const end = sentence.at + sentence.text.length;
      return numbers.filter((number) => number.index > from && number.index < end);
    });
    const emphasized =
      called[0] ??
      (proof ? numbers.find((n) => n.index >= proof.atChar - scene.fromChar) : undefined);
    if (!emphasized) continue;
    const token = emphasized[0];
    const excerpt = literalExcerpt(text, emphasized.index);
    const existing = scene.overlays.findIndex((overlay) => overlay.text.includes(token));
    const withOverlay =
      existing >= 0
        ? { scene, overlay: existing }
        : excerpt && scene.overlays.length < 2
          ? {
              scene: {
                ...scene,
                overlays: [
                  ...scene.overlays,
                  { text: excerpt, position: "top" as const, emphasis: true },
                ],
              },
              overlay: scene.overlays.length,
            }
          : undefined;
    if (!withOverlay) continue;
    const pointer = hasAction("point_at") ? withOverlay.scene.actors[0] : undefined;
    const atWord = wordAt(text, emphasized.index);
    const point: ActorAction = {
      type: "point_at",
      atWord,
      target: { kind: "overlay", index: withOverlay.overlay },
    };
    const pointed = pointer ? actionVariants(withOverlay.scene, pointer.characterKey, point) : [];
    if (tryScenes(index, [...pointed, withOverlay.scene])) continue;
    // The overlay quota is full: free the least important other scene's text, then retry.
    const priority = (purpose: SceneSpec["purpose"]) =>
      purpose === "hook" ? 0 : purpose === "payoff" ? 1 : purpose === "cta" ? 2 : 3;
    const donor = board
      .map((other, i) => ({ other, i }))
      .filter(
        ({ other, i }) =>
          i !== index &&
          other.overlays.length > 0 &&
          !other.actors.some((actor) =>
            (actor.actions ?? []).some(
              (action) => "target" in action && action.target.kind === "overlay",
            ),
          ),
      )
      .sort((a, b) => priority(b.other.purpose) - priority(a.other.purpose) || b.i - a.i)[0];
    if (!donor) continue;
    const saved = board;
    board = board.map((other, i) => (i === donor.i ? { ...other, overlays: [] } : other));
    if (!tryScenes(index, [...pointed, withOverlay.scene])) board = saved;
  }
  return board;
};
