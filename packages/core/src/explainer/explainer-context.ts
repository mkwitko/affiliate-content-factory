import { type Location, readLocations } from "./locations.js";
import { type CharacterBible, readCharacterBible } from "./character-bible.js";
import { readVisualLanguageProfile, type VisualLanguageProfile } from "./visual-language.js";
import type { Niche } from "../niches/niche.js";
import { EXPLAINER_ART_STYLES, type ExplainerArtStyle } from "./background-art.js";
import { type CompositingProfile, readCompositingProfile } from "./compositing.js";

/**
 * The explainer settings of a media niche, read from its free-form context JSON (validated at
 * the MCP boundary by nicheContextSchema). Characters without a rig are image-reference cast
 * for affiliate story slides and are ignored here.
 */
export type CharacterPalette = Readonly<{ line: string; fill: string; accent: string }>;
export type CharacterAccessory = "glasses" | "cap" | "tie" | "headphones";
/**
 * Clothing the rig draws over the stick figure, from a closed catalog so every shape is tested
 * against every pose. Declared once per cast member: storyboards never override it, so a
 * character looks the same in every scene (spec section 11, character consistency).
 */
export const HAIR_STYLES = ["short", "curly", "long", "bun"] as const;
export const TOP_STYLES = ["tshirt", "shirt", "hoodie"] as const;
export const BOTTOM_STYLES = ["pants", "shorts", "skirt"] as const;
export type HairStyle = (typeof HAIR_STYLES)[number];
export type TopStyle = (typeof TOP_STYLES)[number];
export type BottomStyle = (typeof BOTTOM_STYLES)[number];
export type WardrobePiece<S extends string> = Readonly<{ style: S; colour: string }>;
export type CharacterWardrobe = Readonly<{
  hair?: WardrobePiece<HairStyle>;
  top?: WardrobePiece<TopStyle>;
  bottoms?: WardrobePiece<BottomStyle>;
  /** A bigger head (cartoon proportions); the face and head accessories scale with it. */
  head?: "big";
}>;
export type ExplainerCharacter = Readonly<{
  key: string;
  name: string;
  role: "main" | "secondary" | "pet";
  rigId: "stick-v1";
  rigVersion: 1;
  palette: CharacterPalette;
  accessory?: CharacterAccessory;
  wardrobe?: CharacterWardrobe;
  /** Kokoro voice id; the main character's voice narrates every episode of the niche. */
  voiceId?: string;
  /** Character bible (v2 slice 19); absent draws the plain stick-v1 rig. */
  bible?: CharacterBible;
}>;
export type ExplainerNicheContext = Readonly<{
  format: "short" | "long";
  targetSeconds: Readonly<{ min: number; max: number }>;
  captionStyle: Readonly<{ maxWords: 2 | 3 | 4 }>;
  musicPolicy: "none" | "optional";
  characters: readonly ExplainerCharacter[];
  /** The niche's Kokoro voice id (also used by its Reels). */
  voiceId?: string;
  /** Painted-background style of the niche; absent keeps the procedural look. */
  style?: ExplainerArtStyle;
  /** Compositing profile (v2 slice 14); absent renders exactly as before. */
  compositing?: CompositingProfile;
  /** Motion grammar (v2 slice 15); absent or false renders exactly as before. */
  motionGrammar?: true;
  /** Measured visual language (v2 slice 18); absent keeps today's constants. */
  visualLanguage?: VisualLanguageProfile;
  /** Recurring places with zones and anchors (v2 slice 23). */
  locations?: readonly Location[];
}>;

/** Kokoro voice ids: a language/gender prefix and a name, e.g. pf_dora. */
const isVoiceId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z]{2}_[a-z]+$/.test(value);

const accessories: readonly string[] = ["glasses", "cap", "tie", "headphones"];
const isHex = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const piece = <S extends string>(
  value: unknown,
  styles: readonly S[],
): WardrobePiece<S> | undefined =>
  isRecord(value) &&
  typeof value.style === "string" &&
  (styles as readonly string[]).includes(value.style) &&
  isHex(value.colour)
    ? Object.freeze({ style: value.style as S, colour: value.colour })
    : undefined;

const toWardrobe = (value: unknown): CharacterWardrobe | undefined => {
  if (!isRecord(value)) return undefined;
  const hair = piece(value.hair, HAIR_STYLES);
  const top = piece(value.top, TOP_STYLES);
  const bottoms = piece(value.bottoms, BOTTOM_STYLES);
  const wardrobe: CharacterWardrobe = {
    ...(hair ? { hair } : {}),
    ...(top ? { top } : {}),
    ...(bottoms ? { bottoms } : {}),
    ...(value.head === "big" ? { head: "big" as const } : {}),
  };
  return Object.keys(wardrobe).length > 0 ? Object.freeze(wardrobe) : undefined;
};

const toCharacter = (value: unknown): ExplainerCharacter | null => {
  if (!isRecord(value) || !isRecord(value.palette)) return null;
  const { key, name, role, rigId, rigVersion, palette, accessory, voiceId, wardrobe, bible } =
    value;
  if (
    typeof key !== "string" ||
    !/^[a-z][a-z0-9_]{0,31}$/.test(key) ||
    typeof name !== "string" ||
    rigId !== "stick-v1" ||
    rigVersion !== 1 ||
    !isHex(palette.line) ||
    !isHex(palette.fill) ||
    !isHex(palette.accent)
  )
    return null;
  const dressed = toWardrobe(wardrobe);
  return Object.freeze({
    key,
    name,
    role: role === "secondary" || role === "pet" ? role : "main",
    rigId: "stick-v1",
    rigVersion: 1,
    palette: Object.freeze({ line: palette.line, fill: palette.fill, accent: palette.accent }),
    ...(typeof accessory === "string" && accessories.includes(accessory)
      ? { accessory: accessory as CharacterAccessory }
      : {}),
    ...(dressed ? { wardrobe: dressed } : {}),
    ...(isVoiceId(voiceId) ? { voiceId } : {}),
    ...(() => {
      const read = readCharacterBible(bible);
      return read ? { bible: read } : {};
    })(),
  });
};

export const readExplainerContext = (
  niche: Pick<Niche, "kind" | "context">,
): ExplainerNicheContext | null => {
  if (niche.kind !== "media") return null;
  const context = isRecord(niche.context) ? niche.context : {};
  const explainer = isRecord(context.explainer) ? context.explainer : {};
  const target = isRecord(explainer.targetSeconds) ? explainer.targetSeconds : {};
  const caption = isRecord(explainer.captionStyle) ? explainer.captionStyle : {};
  const maxWords = caption.maxWords;
  const characters = Array.isArray(context.characters)
    ? context.characters.map(toCharacter).filter((c): c is ExplainerCharacter => c !== null)
    : [];
  return Object.freeze({
    format: explainer.format === "long" ? "long" : "short",
    targetSeconds: Object.freeze({
      min: typeof target.min === "number" ? target.min : 20,
      max: typeof target.max === "number" ? target.max : 60,
    }),
    captionStyle: Object.freeze({ maxWords: maxWords === 2 || maxWords === 4 ? maxWords : 3 }),
    musicPolicy: explainer.musicPolicy === "optional" ? "optional" : "none",
    characters: Object.freeze(characters),
    ...(isVoiceId(context.voiceId) ? { voiceId: context.voiceId } : {}),
    ...(typeof explainer.style === "string" &&
    (EXPLAINER_ART_STYLES as readonly string[]).includes(explainer.style)
      ? { style: explainer.style as ExplainerArtStyle }
      : {}),
    ...(explainer.motionGrammar === true ? { motionGrammar: true as const } : {}),
    ...(() => {
      const locations = readLocations(explainer.locations);
      return locations.length ? { locations } : {};
    })(),
    ...(() => {
      const visualLanguage = readVisualLanguageProfile(explainer.visualLanguage);
      return visualLanguage ? { visualLanguage } : {};
    })(),
    ...(() => {
      const compositing = readCompositingProfile(explainer.compositing);
      return compositing ? { compositing } : {};
    })(),
  });
};

/**
 * Explainer scenes use a light, high-contrast palette (the affiliate brand kit is tuned for dark
 * product slides); only the accent follows the niche brand kit.
 */
export type ScenePalette = Readonly<{
  surface: string;
  muted: string;
  accent: string;
  text: string;
  line: string;
}>;
export const DEFAULT_SCENE_PALETTE: ScenePalette = Object.freeze({
  surface: "#F6F1E7",
  muted: "#D9D2C5",
  accent: "#FF5A36",
  text: "#161616",
  line: "#161616",
});
export const scenePaletteFor = (niche: Pick<Niche, "context">): ScenePalette => {
  const kit =
    isRecord(niche.context) && isRecord(niche.context.brandKit) ? niche.context.brandKit : {};
  const accent = isRecord(kit.palette) ? kit.palette.accent : undefined;
  return isHex(accent)
    ? Object.freeze({ ...DEFAULT_SCENE_PALETTE, accent })
    : DEFAULT_SCENE_PALETTE;
};
