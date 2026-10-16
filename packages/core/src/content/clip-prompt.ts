/**
 * Compiles a scene's visual description into a generator prompt (spec 4.4). INV-G1: a generated
 * clip never depicts a specific real product, so the negative block is locked and a prompt that
 * names a brand or the offer is refused instead of rewritten.
 */
export const CLIP_PROMPT_MAX_CHARS = 400;
export const CLIP_NEGATIVE_BLOCK =
  "logos, brand names, readable text, captions, watermarks, product packaging, real people, celebrities, deformed hands";

// ponytail: short denylist of marketplaces and big consumer brands; offer facts carry the rest.
const BRAND_DENYLIST = [
  "amazon",
  "mercado livre",
  "shopee",
  "magalu",
  "nike",
  "adidas",
  "apple",
  "iphone",
  "samsung",
  "xiaomi",
  "sony",
  "coca-cola",
] as const;

const fold = (text: string): string =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Words of a title that say what kind of thing it is, not which one it is.
const GENERIC_TITLE_WORDS = new Set(
  (
    "the and for with pro mini max set pack kit par que com sem para por uma dos das dois " +
    "cadeira mesa fone fones camiseta camisa tenis bolsa mochila relogio garrafa caneca copo panela " +
    "luminaria cafeteira liquidificador ventilador carregador cabo capa suporte tapete lampada " +
    "chair desk table bottle bag backpack watch shoes shirt headphones phone lamp mug cup pan pot charger cable case " +
    "novo nova premium original profissional digital eletrico portatil ergonomica smart wireless usb led inox " +
    "preto preta branco branca azul verde vermelho black white blue green red"
  ).split(" "),
);

/** INV-G1: alphanumeric model codes and capitalised words that identify one specific product. */
const distinctiveTitleTokens = (title: string): string[] =>
  title
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => {
      const word = fold(token);
      if (word.length < 3 || GENERIC_TITLE_WORDS.has(word)) return false;
      if (/\p{L}/u.test(token) && /\p{N}/u.test(token)) return true;
      return /^\p{Lu}/u.test(token) && /^\p{L}+$/u.test(token);
    })
    .map(fold);

export type ClipPromptResult =
  | Readonly<{ ok: true; prompt: string; negativePrompt: string }>
  | Readonly<{ ok: false; reason: string }>;

export const compileClipPrompt = (input: {
  clipPrompt: string;
  stylePrefix?: string | undefined;
  cameraHint?: string | undefined;
  /** Offer title, brand and similar facts the clip must not name. */
  forbiddenTerms: readonly string[];
  /** Offer title: refused as a phrase and by its distinctive tokens (model codes, proper nouns). */
  offerTitle?: string | undefined;
}): ClipPromptResult => {
  const scene = input.clipPrompt.trim();
  if (scene.length === 0 || scene.length > CLIP_PROMPT_MAX_CHARS)
    return { ok: false, reason: "prompt_length_invalid" };
  const haystack = fold(scene);
  const terms = [
    ...BRAND_DENYLIST,
    ...input.forbiddenTerms,
    ...(input.offerTitle ? [input.offerTitle, ...distinctiveTitleTokens(input.offerTitle)] : []),
  ];
  for (const term of terms) {
    const needle = fold(term).trim();
    if (needle.length < 3) continue;
    if (
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "u").test(haystack)
    )
      return { ok: false, reason: `brand_named:${needle}` };
  }
  const prompt = [input.stylePrefix?.trim(), scene, input.cameraHint?.trim()]
    .filter((part): part is string => !!part)
    .join(". ");
  return { ok: true, prompt, negativePrompt: CLIP_NEGATIVE_BLOCK };
};
