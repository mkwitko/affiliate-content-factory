import type { ExplainerArtStyle, LineStyle } from "../../background-art.js";

/**
 * Style-frame harness candidates (video slice 13, spec v2 section 9 and 10.1). These ids are the
 * spec's generic style families; the mapping of each family onto what the rig and the plate
 * prompt can draw today is a HYPOTHESIS for the review, not a production profile. No
 * VisualLanguageProfile value is written here (spec section 9 rule).
 */
export type CharacterStyle = "EXPRESSIVE_INK" | "EDITORIAL_FLAT" | "CINEMATIC_GRAPHIC";
export type EnvironmentStyle =
  | "FLAT_VECTOR"
  | "CUTOUT_PAINTED"
  | "GOUACHE_PAINTED"
  | "DARK_GRAPHIC";

export type StyleCandidate = Readonly<{
  id: string;
  characterStyle: CharacterStyle;
  environmentStyle: EnvironmentStyle;
  /** What the existing rig draws for the character family (HYPOTHESIS mapping). */
  lineStyle: LineStyle;
  /** Existing plate prompt style used for the environment family; null draws procedural settings. */
  plateStyle: ExplainerArtStyle | null;
  /** Why this candidate is in the batch; shown in the experiment doc, never to a blind reviewer. */
  rationale: string;
}>;

export const STYLE_CANDIDATES: readonly StyleCandidate[] = [
  {
    id: "flat-vector-control",
    characterStyle: "EDITORIAL_FLAT",
    environmentStyle: "FLAT_VECTOR",
    lineStyle: "clean",
    plateStyle: null,
    rationale:
      "Today's production look (procedural settings, clean line): the control the review sorts against and the permanent fallback (spec 10.1).",
  },
  {
    id: "expressive-ink-cutout-painted",
    characterStyle: "EXPRESSIVE_INK",
    environmentStyle: "CUTOUT_PAINTED",
    lineStyle: "sketch",
    plateStyle: "flat_cartoon",
    rationale:
      "First candidate of spec 10.1: seeded hand-drawn line over flat-cartoon painted plates (the R&D 'faces on kraft plates' direction).",
  },
  {
    id: "expressive-ink-gouache-painted",
    characterStyle: "EXPRESSIVE_INK",
    environmentStyle: "GOUACHE_PAINTED",
    lineStyle: "sketch",
    plateStyle: "sketch_watercolor",
    rationale: "Second candidate of spec 10.1: the same line over sketch-watercolour plates.",
  },
];

export const styleCandidate = (id: string): StyleCandidate => {
  const candidate = STYLE_CANDIDATES.find((entry) => entry.id === id);
  if (!candidate) throw new Error(`style_candidate_unknown:${id}`);
  return candidate;
};
