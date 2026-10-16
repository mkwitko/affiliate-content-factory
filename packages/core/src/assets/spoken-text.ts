import type { SpeechSynthesizer, SpokenWord } from "./speech-synthesizer.js";
import { expandSpokenEn } from "./spoken-text-en.js";

/**
 * Deterministic Brazilian Portuguese spoken-form expansion for narration text.
 *
 * Kokoro's pt-BR path relies on espeak-ng G2P, which reads "R$ 329,90" as "real dólar trezentos
 * e vinte e nove, noventa" and "1.500" as "um, quinhentos" (measured 2026-09-30 against
 * kokoro-fastapi v0.9.0). This module expands prices, percentages, decimals, thousands, units
 * and hh'h'mm times into words before synthesis, then maps the returned word timings back onto
 * the original display tokens so captions still show "R$ 329,90".
 *
 * Pure: no IO, no model. Anything it does not recognise passes through untouched.
 */

export type Gender = "m" | "f";

export type SpokenGroup = Readonly<{
  /** Original text for captions, including attached punctuation. */
  display: string;
  /** How many whitespace-separated words the spoken form has. */
  spokenWordCount: number;
}>;

const UNITS = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const TEENS = [
  "dez",
  "onze",
  "doze",
  "treze",
  "quatorze",
  "quinze",
  "dezesseis",
  "dezessete",
  "dezoito",
  "dezenove",
];
const TENS = [
  "",
  "",
  "vinte",
  "trinta",
  "quarenta",
  "cinquenta",
  "sessenta",
  "setenta",
  "oitenta",
  "noventa",
];
const HUNDREDS = [
  "",
  "cento",
  "duzentos",
  "trezentos",
  "quatrocentos",
  "quinhentos",
  "seiscentos",
  "setecentos",
  "oitocentos",
  "novecentos",
];

const feminine = (word: string): string =>
  word === "um"
    ? "uma"
    : word === "dois"
      ? "duas"
      : word.endsWith("entos")
        ? word.replace(/os$/, "as")
        : word;

const belowThousand = (n: number, gender: Gender): string => {
  if (n === 100) return "cem";
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h > 0) parts.push(gender === "f" ? feminine(HUNDREDS[h] ?? "") : (HUNDREDS[h] ?? ""));
  if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10] ?? "");
  else {
    const t = Math.floor(rest / 10);
    const u = rest % 10;
    if (t > 0) parts.push(TENS[t] ?? "");
    if (u > 0) parts.push(gender === "f" ? feminine(UNITS[u] ?? "") : (UNITS[u] ?? ""));
  }
  return parts.join(" e ");
};

/** Joins a big-unit chunk to its remainder: "mil e quinhentos" but "mil duzentos e trinta". */
const joinRemainder = (head: string, rest: number, restWords: string): string => {
  if (rest === 0) return head;
  const connector = rest <= 100 || rest % 100 === 0 ? " e " : " ";
  return `${head}${connector}${restWords}`;
};

/** Cardinal number in pt-BR words, 0 .. 999_999_999. Gender applies to 1, 2 and the hundreds. */
export const numberToWordsPtBr = (n: number, gender: Gender = "m"): string => {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000_000) return String(n);
  if (n === 0) return "zero";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const rest = n % 1000;
  let words = "";
  if (millions > 0) {
    words = millions === 1 ? "um milhão" : `${belowThousand(millions, "m")} milhões`;
  }
  if (thousands > 0) {
    const head = thousands === 1 ? "mil" : `${belowThousand(thousands, "m")} mil`;
    words = words ? joinRemainder(words, thousands * 1000 + rest, head) : head;
    if (millions > 0) return joinRemainder(words, rest, belowThousand(rest, gender));
  }
  if (rest > 0) {
    const restWords = belowThousand(rest, gender);
    words = words ? joinRemainder(words, rest, restWords) : restWords;
  }
  return words;
};

const parseInteger = (digits: string): number => Number.parseInt(digits.replace(/\./g, ""), 10);

const plural = (n: number, singular: string, pluralForm: string): string =>
  n === 1 ? singular : pluralForm;

/** Unit abbreviations that appear in product copy: [singular, plural, gender]. */
const UNIT_WORDS: Readonly<Record<string, readonly [string, string, Gender]>> = {
  ml: ["mililitro", "mililitros", "m"],
  l: ["litro", "litros", "m"],
  kg: ["quilo", "quilos", "m"],
  g: ["grama", "gramas", "m"],
  mg: ["miligrama", "miligramas", "m"],
  km: ["quilômetro", "quilômetros", "m"],
  m: ["metro", "metros", "m"],
  cm: ["centímetro", "centímetros", "m"],
  mm: ["milímetro", "milímetros", "m"],
  w: ["watt", "watts", "m"],
  h: ["hora", "horas", "f"],
  min: ["minuto", "minutos", "m"],
  gb: ["gigabyte", "gigabytes", "m"],
  mb: ["megabyte", "megabytes", "m"],
  tb: ["terabyte", "terabytes", "m"],
  v: ["volt", "volts", "m"],
  hz: ["hertz", "hertz", "m"],
  k: ["K", "K", "m"],
  mah: ["miliampère-hora", "miliampères-hora", "m"],
};

/** Common feminine nouns after a bare number, so "2 marcas" reads "duas marcas". */
const FEMININE_NOUNS = new Set([
  "marcas",
  "marca",
  "horas",
  "hora",
  "semanas",
  "semana",
  "vezes",
  "vez",
  "pessoas",
  "pessoa",
  "unidades",
  "unidade",
  "cores",
  "cor",
  "velocidades",
  "velocidade",
  "funções",
  "função",
  "peças",
  "peça",
  "camadas",
  "camada",
  "opções",
  "opção",
  "avaliações",
  "avaliação",
  "estrelas",
  "estrela",
  "parcelas",
  "parcela",
  "polegadas",
  "polegada",
]);

const decimalToWords = (integer: string, fraction: string, gender: Gender): string =>
  `${numberToWordsPtBr(parseInteger(integer), gender)} vírgula ${[...fraction]
    .map((d) => numberToWordsPtBr(Number(d)))
    .join(" ")}`;

/**
 * Prices are read the way people say them (owner 2026-10-07): "R$ 35,87" is "trinta e cinco com
 * oitenta e sete", not "... reais e oitenta e sete centavos". Units stay only on whole amounts
 * ("vinte e nove reais", "um real") and on cents alone ("cinquenta centavos").
 */
const currencyToWords = (integer: string, cents: string | undefined): string => {
  const reais = parseInteger(integer);
  const centavos = cents ? Number.parseInt(cents, 10) : 0;
  if (centavos === 0) return `${numberToWordsPtBr(reais)} ${plural(reais, "real", "reais")}`;
  if (reais === 0)
    return `${numberToWordsPtBr(centavos)} ${plural(centavos, "centavo", "centavos")}`;
  return `${numberToWordsPtBr(reais)} com ${numberToWordsPtBr(centavos)}`;
};

const NUMBER = String.raw`\d{1,3}(?:\.\d{3})+|\d+`;
const CURRENCY = new RegExp(String.raw`^R\$\s?(${NUMBER})(?:,(\d{2}))?$`, "u");
const PERCENT = new RegExp(String.raw`^(${NUMBER})(?:,(\d+))?%$`, "u");
const TIME = /^(\d{1,2})h(\d{2})$/u;
const NUMBER_UNIT = new RegExp(String.raw`^(${NUMBER})(?:,(\d+))?\s?([a-zA-Z]{1,3})$`, "u");
/** "5.3" after Bluetooth/USB: a version, read "cinco ponto três" (not a thousands group). */
const VERSION = /^(\d{1,2})\.(\d{1,2})$/u;
const DECIMAL = new RegExp(String.raw`^(${NUMBER}),(\d+)$`, "u");
const INTEGER = new RegExp(String.raw`^(${NUMBER})$`, "u");
const LEADING_PUNCT = /^[^\p{L}\p{N}R$]+/u;
const TRAILING_PUNCT = /[^\p{L}\p{N}%]+$/u;

const expandCore = (core: string, next: string | undefined): string | null => {
  const currency = CURRENCY.exec(core);
  if (currency) return currencyToWords(currency[1] ?? "0", currency[2]);
  const percent = PERCENT.exec(core);
  if (percent) {
    const value = percent[2]
      ? decimalToWords(percent[1] ?? "0", percent[2], "m")
      : numberToWordsPtBr(parseInteger(percent[1] ?? "0"));
    return `${value} por cento`;
  }
  const version = VERSION.exec(core);
  if (version)
    return `${numberToWordsPtBr(Number(version[1]))} ponto ${numberToWordsPtBr(Number(version[2]))}`;
  const time = TIME.exec(core);
  if (time) return `${numberToWordsPtBr(Number(time[1]))} e ${numberToWordsPtBr(Number(time[2]))}`;
  const withUnit = NUMBER_UNIT.exec(core);
  if (withUnit) {
    const unit = UNIT_WORDS[(withUnit[3] ?? "").toLowerCase()];
    if (!unit) return null;
    const [singular, pluralForm, gender] = unit;
    const value = withUnit[2]
      ? decimalToWords(withUnit[1] ?? "0", withUnit[2], gender)
      : numberToWordsPtBr(parseInteger(withUnit[1] ?? "0"), gender);
    const count = withUnit[2] ? 2 : parseInteger(withUnit[1] ?? "0");
    return `${value} ${plural(count, singular, pluralForm)}`;
  }
  const nextWord = next?.toLowerCase().replace(TRAILING_PUNCT, "");
  const gender: Gender = nextWord && FEMININE_NOUNS.has(nextWord) ? "f" : "m";
  const decimal = DECIMAL.exec(core);
  if (decimal) return decimalToWords(decimal[1] ?? "0", decimal[2] ?? "", gender);
  const integer = INTEGER.exec(core);
  if (integer) return numberToWordsPtBr(parseInteger(integer[1] ?? "0"), gender);
  return null;
};

const BARE_NUMBER = new RegExp(String.raw`^(?:${NUMBER})(?:,\d+)?$`, "u");
const isUnitWord = (chunk: string): boolean => {
  const core = chunk.replace(TRAILING_PUNCT, "");
  return /^[a-zA-Z]{1,3}$/u.test(core) && core.toLowerCase() in UNIT_WORDS;
};

/** Splits on whitespace, then glues "R$" and unit abbreviations to their amounts. */
const chunks = (text: string): string[] => {
  const raw = text.split(/\s+/u).filter((c) => c.length > 0);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const chunk = raw[i] ?? "";
    const next = raw[i + 1];
    if (/^R\$$/u.test(chunk) && next && /^\d/u.test(next)) {
      out.push(`${chunk} ${next}`);
      i += 1;
    } else if (next && BARE_NUMBER.test(chunk) && isUnitWord(next)) {
      out.push(`${chunk} ${next}`);
      i += 1;
    } else out.push(chunk);
  }
  return out;
};

/**
 * Expands a pt-BR narration into its spoken form. `groups` maps each display token to how
 * many spoken words it produced, so timings can be folded back with `collapseSpokenWords`.
 */
export const expandSpokenPtBr = (
  text: string,
): Readonly<{ spoken: string; groups: readonly SpokenGroup[] }> => {
  const parts = chunks(text);
  const groups: SpokenGroup[] = [];
  const spokenParts: string[] = [];
  parts.forEach((display, index) => {
    const lead = LEADING_PUNCT.exec(display)?.[0] ?? "";
    const withoutLead = display.slice(lead.length);
    const trail = TRAILING_PUNCT.exec(withoutLead)?.[0] ?? "";
    const core = withoutLead.slice(0, withoutLead.length - trail.length);
    const expanded = core.length > 0 ? expandCore(core, parts[index + 1]) : null;
    const spoken = expanded === null ? display : `${lead}${expanded}${trail}`;
    spokenParts.push(spoken);
    groups.push({ display, spokenWordCount: spoken.split(/\s+/u).length });
  });
  return { spoken: spokenParts.join(" "), groups };
};

/**
 * Folds synthesizer words (one per spoken word) back onto display tokens. Returns null when the
 * counts do not line up, so callers can keep the synthesizer's own words instead of guessing.
 */
export const collapseSpokenWords = (
  words: readonly SpokenWord[],
  groups: readonly SpokenGroup[],
): readonly SpokenWord[] | null => {
  const expected = groups.reduce((sum, group) => sum + group.spokenWordCount, 0);
  if (words.length !== expected) return null;
  const out: SpokenWord[] = [];
  let cursor = 0;
  for (const group of groups) {
    const first = words[cursor];
    const last = words[cursor + group.spokenWordCount - 1];
    if (!first || !last) return null;
    out.push({ text: group.display, startMs: first.startMs, endMs: last.endMs });
    cursor += group.spokenWordCount;
  }
  return out;
};

/**
 * Wraps a `SpeechSynthesizer` so Portuguese and English narration is synthesized from its spoken form while
 * the returned words keep the original display text and the synthesizer's timings.
 */
export const createSpokenTextSynthesizer = (inner: SpeechSynthesizer): SpeechSynthesizer => ({
  async synthesize(input) {
    const expand = /^pt(-|$)/iu.test(input.language)
      ? expandSpokenPtBr
      : /^en(-|$)/iu.test(input.language)
        ? expandSpokenEn
        : null;
    if (!expand) return inner.synthesize(input);
    const { spoken, groups } = expand(input.text);
    if (spoken === input.text) return inner.synthesize(input);
    const result = await inner.synthesize({ ...input, text: spoken });
    const words = collapseSpokenWords(result.words, groups);
    return words ? { ...result, words } : result;
  },
});
