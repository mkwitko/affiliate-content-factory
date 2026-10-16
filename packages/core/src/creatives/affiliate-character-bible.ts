/**
 * Typed, versioned look of an affiliate cartoon character (Carla, Bia, Rafa), kept in the niche
 * context under `characters[].affiliateBible`. Not the stickman bible (explainer/character-bible).
 * Parsed defensively: anything absent or malformed returns null and the prompt stays as before.
 */
export const AFFILIATE_BIBLE_VERSION = 1;
export const AFFILIATE_BIBLE_LIMITS = Object.freeze({ text: 300, list: 12, item: 80, palette: 8 });

export type AffiliateCharacterBible = Readonly<{
  version: number;
  appearance: string;
  proportions: string;
  hair: string;
  wardrobe: string;
  /** #rrggbb, lower-cased. */
  palette: readonly string[];
  expressions: readonly string[];
  poses: readonly string[];
  forbiddenChanges: readonly string[];
  voiceId?: string;
}>;

const L = AFFILIATE_BIBLE_LIMITS;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" && value.trim().length <= max
    ? value.trim().replace(/\s+/g, " ")
    : null;
const list = (value: unknown, max: number, item: number): string[] | null => {
  if (!Array.isArray(value) || value.length > max) return null;
  const out = value.map((entry) => text(entry, item));
  return out.every((entry): entry is string => entry !== null) ? out : null;
};

export const parseAffiliateBible = (raw: unknown): AffiliateCharacterBible | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== AFFILIATE_BIBLE_VERSION) return null;
  const appearance = text(r.appearance, L.text);
  const proportions = text(r.proportions, L.text);
  const hair = text(r.hair, L.text);
  const wardrobe = text(r.wardrobe, L.text);
  const palette = list(r.palette, L.palette, 7);
  const expressions = list(r.expressions, L.list, L.item);
  const poses = list(r.poses, L.list, L.item);
  const forbiddenChanges = list(r.forbiddenChanges, L.list, L.item);
  if (
    !appearance ||
    !proportions ||
    !hair ||
    !wardrobe ||
    !palette ||
    !expressions ||
    !poses ||
    !forbiddenChanges ||
    !palette.every((hex) => /^#[0-9a-fA-F]{6}$/.test(hex))
  )
    return null;
  const voiceId =
    typeof r.voiceId === "string" && /^[a-z]{2}_[a-z]+$/.test(r.voiceId) ? r.voiceId : undefined;
  return {
    version: AFFILIATE_BIBLE_VERSION,
    appearance,
    proportions,
    hair,
    wardrobe,
    palette: palette.map((hex) => hex.toLowerCase()),
    expressions,
    poses,
    forbiddenChanges,
    ...(voiceId ? { voiceId } : {}),
  };
};

/** The requested value when the bible allows it, else the first allowed one (none: no clause). */
const constrain = (allowed: readonly string[], requested?: string): string | undefined =>
  requested && allowed.includes(requested) ? requested : allowed[0];

/** Compact, deterministic prompt sentences; never mentions the product, prices or text. */
export const affiliateBibleClause = (
  bible: AffiliateCharacterBible,
  pick: Readonly<{ expression?: string | undefined; pose?: string | undefined }> = {},
): string => {
  const expression = constrain(bible.expressions, pick.expression);
  const pose = constrain(bible.poses, pick.pose);
  return [
    `Character bible v${bible.version}: ${bible.appearance}; proportions ${bible.proportions}; hair ${bible.hair}; wardrobe ${bible.wardrobe}.`,
    ...(bible.palette.length ? [`Palette ${bible.palette.join(" ")}.`] : []),
    ...(expression ? [`Expression: ${expression}.`] : []),
    ...(pose ? [`Pose: ${pose}.`] : []),
    ...(bible.forbiddenChanges.length
      ? [`Never change: ${bible.forbiddenChanges.join("; ")}.`]
      : []),
  ].join(" ");
};
