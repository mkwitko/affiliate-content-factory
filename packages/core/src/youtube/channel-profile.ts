import type { Niche } from "../niches/niche.js";

/** A labelled entry of a title or hook taxonomy, e.g. { id: "CC1", label: "WHY_BEHAVIOR" }. */
export type PackagingPattern = Readonly<{
  id: string;
  label: string;
  description?: string;
  example?: string;
}>;
export type PackagingProfile = Readonly<{
  tagline?: string;
  cadence?: Readonly<{ longFormPerWeek: number; shortsPerLongForm: number }>;
  forbiddenPhrases: readonly string[];
  maxOverlayWords: number;
  titlePatterns: readonly PackagingPattern[];
  hookPatterns: readonly PackagingPattern[];
  thumbnailRules: readonly string[];
}>;

const DEFAULT_MAX_OVERLAY_WORDS = 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const toPattern = (value: unknown): PackagingPattern | null => {
  if (!isRecord(value)) return null;
  const { id, label, description, example } = value;
  if (typeof id !== "string" || !/^[A-Z]{2}\d{1,2}$/.test(id)) return null;
  if (typeof label !== "string" || !label.trim()) return null;
  return Object.freeze({
    id,
    label,
    ...(typeof description === "string" && description ? { description } : {}),
    ...(typeof example === "string" && example ? { example } : {}),
  });
};
const patterns = (value: unknown): readonly PackagingPattern[] =>
  Array.isArray(value) ? value.map(toPattern).filter((p): p is PackagingPattern => p !== null) : [];

/**
 * The packaging settings of a media niche (title and hook taxonomies, thumbnail rules, forbidden
 * phrases), read from its free-form context JSON (validated at the MCP boundary by
 * nicheContextSchema). Null when the niche is not media or declares no `packaging`.
 */
export const readPackagingProfile = (
  niche: Pick<Niche, "kind" | "context">,
): PackagingProfile | null => {
  if (niche.kind !== "media" || !isRecord(niche.context)) return null;
  const context = niche.context;
  if (!isRecord(context.packaging)) return null;
  const packaging = context.packaging;
  const cadence = isRecord(context.cadence) ? context.cadence : {};
  return Object.freeze({
    ...(typeof context.tagline === "string" && context.tagline ? { tagline: context.tagline } : {}),
    ...(inRange(cadence.longFormPerWeek, 1, 14) && inRange(cadence.shortsPerLongForm, 0, 6)
      ? {
          cadence: Object.freeze({
            longFormPerWeek: cadence.longFormPerWeek,
            shortsPerLongForm: cadence.shortsPerLongForm,
          }),
        }
      : {}),
    forbiddenPhrases: Object.freeze(strings(context.forbiddenPhrases)),
    maxOverlayWords: inRange(packaging.maxOverlayWords, 0, 6)
      ? packaging.maxOverlayWords
      : DEFAULT_MAX_OVERLAY_WORDS,
    titlePatterns: Object.freeze(patterns(packaging.titlePatterns)),
    hookPatterns: Object.freeze(patterns(packaging.hookPatterns)),
    thumbnailRules: Object.freeze(strings(packaging.thumbnailRules)),
  });
};
