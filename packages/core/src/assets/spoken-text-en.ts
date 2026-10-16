import type { SpokenGroup } from "./spoken-text.js";

/**
 * Deterministic en-US spoken-form expansion, the English twin of `expandSpokenPtBr`. Only the
 * text sent to the synthesizer changes; `groups` maps each written token to its spoken word
 * count so `collapseSpokenWords` folds timings back onto the written words.
 *
 * Spoken words are space separated, never hyphenated ("twenty five", not "twenty-five"), so the
 * spoken word count is exact for any synthesizer that splits on whitespace.
 *
 * Readings (American style, no "and" inside a number):
 * - Amounts with cents under $100: "$9.99" -> "nine ninety nine", "$1.50" -> "one fifty",
 *   "$4.05" -> "four oh five". Whole amounts name the unit: "$20" -> "twenty dollars",
 *   "$10.00" -> "ten dollars". At $100 or more: "$210.50" -> "two hundred ten dollars and fifty
 *   cents".
 * - "$10 million" -> "ten million dollars"; "$2.4 billion" -> "two point four billion dollars".
 * - "25%" -> "twenty five percent". A bare decimal ("24.8 percent") is left exactly as written.
 * - Decades: "1920s" -> "nineteen twenties", "2010s" -> "twenty tens".
 * - Years only after a cue word (in, since, by, from, until, ...) or a range with an earlier year:
 *   "in 1999" -> "nineteen ninety nine", "in 2014" -> "twenty fourteen", "in 2005" -> "two
 *   thousand five". An uncued 4-digit number is a quantity: "1500" -> "one thousand five hundred".
 * - Plain integers become cardinals: "210" -> "two hundred ten", "79,900" -> "seventy nine
 *   thousand nine hundred", "30 and 95" -> "thirty and ninety five".
 * Anything else ("30-day", "4K", "1st", "3.5") passes through untouched.
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const below100 = (n: number): string =>
  n < 20 ? (ONES[n] ?? "") : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;

const below1000 = (n: number): string => {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} hundred` : "", rest ? below100(rest) : ""].filter(Boolean).join(" ");
};

const SCALES: readonly (readonly [number, string])[] = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1000, "thousand"],
];

/** Cardinal in en-US words, 0 .. 999_999_999_999. */
export const numberToWordsEn = (n: number): string => {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000_000_000) return String(n);
  if (n === 0) return "zero";
  let rest = n;
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${below1000(count)} ${name}`);
    rest %= size;
  }
  if (rest > 0) parts.push(below1000(rest));
  return parts.join(" ");
};

const digitsToWords = (digits: string): string => [...digits].map((d) => ONES[Number(d)]).join(" ");

const parseInteger = (digits: string): number => Number.parseInt(digits.replace(/,/gu, ""), 10);

/** "2.4" -> "two point four"; the fraction is read digit by digit. */
const decimalWords = (integer: string, fraction: string): string =>
  `${numberToWordsEn(parseInteger(integer))} point ${digitsToWords(fraction)}`;

const pluralize = (n: number, singular: string, pluralForm: string): string =>
  n === 1 ? singular : pluralForm;

const dollarsToWords = (integer: string, cents: string | undefined): string => {
  const dollars = parseInteger(integer);
  const c = cents ? Number.parseInt(cents, 10) : 0;
  const small = dollars < 100 && !integer.includes(",");
  if (cents && c > 0 && small) {
    const centsWords = c < 10 ? `oh ${ONES[c]}` : below100(c);
    return dollars === 0
      ? `${numberToWordsEn(c)} ${pluralize(c, "cent", "cents")}`
      : `${numberToWordsEn(dollars)} ${centsWords}`;
  }
  const dollarWords = `${numberToWordsEn(dollars)} ${pluralize(dollars, "dollar", "dollars")}`;
  if (!cents || c === 0) return dollarWords;
  const centWords = `${numberToWordsEn(c)} ${pluralize(c, "cent", "cents")}`;
  return dollars === 0 ? centWords : `${dollarWords} and ${centWords}`;
};

const yearToWords = (y: number): string => {
  if (y % 1000 === 0) return `${ONES[y / 1000]} thousand`;
  if (y >= 2000 && y < 2010) return `two thousand ${ONES[y % 10]}`;
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${below100(hi)} hundred`;
  return `${below100(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : below100(lo)}`;
};

const decadeToWords = (y: number): string => {
  const hi = Math.floor(y / 100);
  const decade = y % 100;
  if (decade === 0) return `${hi === 20 ? "two thousand" : `${below100(hi)} hundred`}s`;
  const tens = below100(decade);
  const plural = decade === 10 ? "tens" : tens.replace(/y$/u, "ies");
  return `${below100(hi)} ${plural}`;
};

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+|\d+`;
const DOLLARS = new RegExp(String.raw`^\$(${NUMBER})(?:\.(\d{2}))?$`, "u");
const DOLLARS_SCALE = new RegExp(
  String.raw`^\$(${NUMBER})(?:\.(\d+))? (million|billion|trillion)$`,
  "iu",
);
const PERCENT = new RegExp(String.raw`^(${NUMBER})(?:\.(\d+))?%$`, "u");
const DECADE = /^(1[0-9]|20)\d0s$/u;
const YEAR = /^(1[1-9]|20)\d{2}$/u;
const INTEGER = new RegExp(String.raw`^(?:${NUMBER})$`, "u");
const SCALE_WORD = /^(?:million|billion|trillion)$/iu;
const LEADING_PUNCT = /^[^\p{L}\p{N}$]+/u;
const TRAILING_PUNCT = /[^\p{L}\p{N}%]+$/u;
const YEAR_CUES = new Set([
  "in",
  "since",
  "by",
  "from",
  "until",
  "till",
  "of",
  "circa",
  "before",
  "after",
  "during",
  "year",
  "through",
]);

const coreOf = (token: string): string =>
  token.replace(LEADING_PUNCT, "").replace(TRAILING_PUNCT, "");

/** True when `before` / `before2` (the written tokens just ahead of a 4-digit number) mark it a year. */
const yearCued = (before: string | undefined, before2: string | undefined): boolean => {
  const word = before ? coreOf(before).toLowerCase() : "";
  if (YEAR_CUES.has(word)) return true;
  // "from 1999 to 2014", "between 1999 and 2014": a range whose start is itself a year.
  return (word === "to" || word === "and") && before2 !== undefined && YEAR.test(coreOf(before2));
};

/** Glues "$10" / "$2.4" to a following "million|billion|trillion" so they read as one amount. */
const chunks = (text: string): string[] => {
  const raw = text.split(/\s+/u).filter((c) => c.length > 0);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const chunk = raw[i] ?? "";
    const next = raw[i + 1];
    if (next && /^\$\d(?:[\d,.]*\d)?$/u.test(chunk) && SCALE_WORD.test(coreOf(next))) {
      out.push(`${chunk} ${next}`);
      i += 1;
    } else out.push(chunk);
  }
  return out;
};

const expandCore = (
  core: string,
  before: string | undefined,
  before2: string | undefined,
): string | null => {
  // Beyond the cardinal range the written number is left for the synthesizer, never String(n).
  if ((core.match(/\d[\d,]*/gu) ?? []).some((m) => parseInteger(m) >= 1_000_000_000_000))
    return null;
  const dollars = DOLLARS.exec(core);
  if (dollars) return dollarsToWords(dollars[1] ?? "0", dollars[2]);
  const percent = PERCENT.exec(core);
  if (percent) {
    const value = percent[2]
      ? decimalWords(percent[1] ?? "0", percent[2])
      : numberToWordsEn(parseInteger(percent[1] ?? "0"));
    return `${value} percent`;
  }
  if (DECADE.test(core)) return decadeToWords(Number.parseInt(core, 10));
  if (YEAR.test(core) && yearCued(before, before2)) return yearToWords(Number(core));
  if (INTEGER.test(core) && !/^0\d/u.test(core)) return numberToWordsEn(parseInteger(core));
  return null;
};

export const expandSpokenEn = (
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
    const scaled = DOLLARS_SCALE.exec(core);
    if (scaled) {
      // Two written words, so two groups: "$10" -> "ten", "million," -> "million dollars,".
      const amount = scaled[2]
        ? decimalWords(scaled[1] ?? "0", scaled[2])
        : numberToWordsEn(parseInteger(scaled[1] ?? "0"));
      const [first = "", second = ""] = display.split(" ");
      groups.push({ display: first, spokenWordCount: amount.split(" ").length });
      groups.push({ display: second, spokenWordCount: 2 });
      spokenParts.push(`${lead}${amount} ${(scaled[3] ?? "").toLowerCase()} dollars${trail}`);
      return;
    }
    const expanded = core.length > 0 ? expandCore(core, parts[index - 1], parts[index - 2]) : null;
    const spoken = expanded === null ? display : `${lead}${expanded}${trail}`;
    spokenParts.push(spoken);
    groups.push({ display, spokenWordCount: spoken.split(/\s+/u).length });
  });
  return { spoken: spokenParts.join(" "), groups };
};
