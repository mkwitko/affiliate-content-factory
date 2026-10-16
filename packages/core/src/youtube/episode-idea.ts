import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import type { PackagingProfile } from "./channel-profile.js";

/** Why a transition or input was refused; the MCP layer reports it as EPISODE_IDEA_REJECTED:<code>. */
export type EpisodeIdeaErrorCode =
  | "score_dimension_missing"
  | "score_out_of_range"
  | "unknown_title_pattern"
  | "unknown_hook_pattern"
  | "variant_count"
  | "variant_ids"
  | "invalid_transition"
  | "unknown_variant"
  | "duplicate_message"
  | "hook_contract_missing"
  | "hook_contract_invalid";
export class EpisodeIdeaError extends Error {
  public constructor(public readonly code: EpisodeIdeaErrorCode) {
    super(code);
    this.name = "EpisodeIdeaError";
  }
}

export type EpisodeIdeaStatus =
  | "idea"
  | "packaging"
  | "approved"
  | "rejected"
  | "in_production"
  | "archived";
export const EPISODE_IDEA_STATUSES: readonly EpisodeIdeaStatus[] = [
  "idea",
  "packaging",
  "approved",
  "rejected",
  "in_production",
  "archived",
];

export type EvidenceType =
  | "OFFICIAL_PLATFORM_FACT"
  | "CHANNEL_OBSERVATION"
  | "EXTERNAL_HEURISTIC"
  | "OUR_HYPOTHESIS";
export type IdeaEvidence = Readonly<{
  statement: string;
  evidenceType: EvidenceType;
  source?: string;
  observationId?: string;
}>;

/** Maximum points per dimension; they add up to 100. */
export const SCORE_MAX = {
  browse: 15,
  title: 10,
  thumbnail: 10,
  hook: 10,
  story: 15,
  evergreen: 10,
  audienceEvidence: 10,
  libraryAdjacency: 5,
  monetization: 5,
  feasibility: 5,
  originality: 5,
} as const;
export type ScoreDimension = keyof typeof SCORE_MAX;
export type IdeaScore = Readonly<{
  dimensions: Readonly<Record<ScoreDimension, number>>;
  total: number;
  rationale: string;
  confidence: "low" | "medium" | "high";
  evidence: readonly IdeaEvidence[];
}>;

export type ThumbnailConcept = Readonly<{
  angle: string;
  focalSubject: string;
  secondaryObject?: string;
  overlayText?: string;
  composition: string;
  background: string;
  contrastStrategy: string;
  emotion?: string;
  titleThumbnailSplit: string;
  hypothesis: string;
}>;
export type PackagingVariant = Readonly<{
  id: "A" | "B" | "C";
  title: string;
  titlePattern: string;
  thumbnail: ThumbnailConcept;
  hookPattern: string;
  openingHook: string;
  audiencePromise: string;
  hypothesis: string;
  expectedStrengths?: readonly string[];
  risks?: readonly string[];
}>;
export type PackagingChecks = Readonly<{
  semanticOverlap: number;
  duplicateMessage: boolean;
  complementary: boolean;
  overlayWordCount: number;
  notes: readonly string[];
}>;
export type VariantChecks = Readonly<{ variantId: PackagingVariant["id"] }> & PackagingChecks;

/** What the opening of the video owes the viewer who clicked; script review checks it. */
export type HookContract = Readonly<{
  packagingPromise: string;
  firstVisual: string;
  proofOrTensionBySecond: number;
  firstOpenLoop: string;
  firstOpenLoopBySecond: number;
  firstPartialPayoffBySecond: number;
  deeperQuestion?: string;
  prohibitedIntroElements: readonly string[];
}>;

export type EpisodeIdea = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  workingTitle: string;
  status: EpisodeIdeaStatus;
  score: IdeaScore;
  packaging?: readonly PackagingVariant[];
  packagingChecks?: readonly VariantChecks[];
  selectedVariantId?: PackagingVariant["id"];
  hookContract?: HookContract;
  decisionNote?: string;
  contentItemId?: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export const scoreIdea = (input: {
  dimensions: Readonly<Partial<Record<ScoreDimension, number>>>;
  rationale: string;
  confidence: IdeaScore["confidence"];
  evidence: readonly IdeaEvidence[];
}): IdeaScore => {
  let total = 0;
  const dimensions = {} as Record<ScoreDimension, number>;
  for (const key of Object.keys(SCORE_MAX) as ScoreDimension[]) {
    const value = input.dimensions[key];
    if (value === undefined) throw new EpisodeIdeaError("score_dimension_missing");
    if (!Number.isFinite(value) || value < 0 || value > SCORE_MAX[key])
      throw new EpisodeIdeaError("score_out_of_range");
    dimensions[key] = value;
    total += value;
  }
  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    total,
    rationale: input.rationale,
    confidence: input.confidence,
    evidence: Object.freeze([...input.evidence]),
  });
};

export const createEpisodeIdea = (input: {
  id?: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  workingTitle: string;
  score: IdeaScore;
  now: Date;
}): EpisodeIdea =>
  Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    nicheId: input.nicheId,
    workingTitle: input.workingTitle.trim(),
    status: "idea",
    score: input.score,
    createdAt: input.now,
    updatedAt: input.now,
  });

/** Case, spacing and punctuation insensitive key for spotting a re-created idea. */
export const normalizeWorkingTitle = (title: string): string =>
  title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%]+/gu, " ")
    .trim();

const STOP_WORDS = new Set(
  "a an and are as at be but by for from has have how in is it its of on or that the this to was were what when where which who why will with you your".split(
    " ",
  ),
);
/** Words with "$9.99" and "don't" kept whole; a sentence's final period or quote is not part of a word. */
const wordsOf = (text: string): readonly string[] =>
  (text.toLowerCase().match(/[\p{L}\p{N}$.']+/gu) ?? [])
    .map((w) => w.replace(/[.']+$/u, ""))
    .filter(Boolean);
export const contentWords = (text: string): ReadonlySet<string> =>
  new Set(wordsOf(text).filter((w) => !STOP_WORDS.has(w)));
const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
};
const DUPLICATE_OVERLAP = 0.6;

export const checkPackagingVariant = (
  variant: PackagingVariant,
  profile: PackagingProfile,
): PackagingChecks => {
  if (!profile.titlePatterns.some((p) => p.id === variant.titlePattern))
    throw new EpisodeIdeaError("unknown_title_pattern");
  if (!profile.hookPatterns.some((p) => p.id === variant.hookPattern))
    throw new EpisodeIdeaError("unknown_hook_pattern");
  const overlay = variant.thumbnail.overlayText ?? "";
  const title = contentWords(variant.title);
  const overlayWords = contentWords(overlay);
  const semanticOverlap = jaccard(title, overlayWords);
  const duplicateMessage =
    overlayWords.size > 0 &&
    ([...overlayWords].every((w) => title.has(w)) || semanticOverlap >= DUPLICATE_OVERLAP);
  const overlayWordCount = wordsOf(overlay).length;
  const notes: string[] = [];
  if (duplicateMessage) notes.push("thumbnail text repeats the title");
  if (overlayWordCount > profile.maxOverlayWords)
    notes.push(
      `overlay has ${overlayWordCount} words, the profile allows ${profile.maxOverlayWords}`,
    );
  return Object.freeze({
    semanticOverlap: Math.round(semanticOverlap * 100) / 100,
    duplicateMessage,
    complementary: !duplicateMessage,
    overlayWordCount,
    notes: Object.freeze(notes),
  });
};

/** Set-level notes; throws when the set itself is malformed. */
export const checkVariantSet = (variants: readonly PackagingVariant[]): readonly string[] => {
  if (variants.length < 2 || variants.length > 3) throw new EpisodeIdeaError("variant_count");
  if (new Set(variants.map((v) => v.id)).size !== variants.length)
    throw new EpisodeIdeaError("variant_ids");
  const notes: string[] = [];
  for (const [i, a] of variants.entries())
    for (const b of variants.slice(i + 1))
      if (jaccard(contentWords(a.title), contentWords(b.title)) >= DUPLICATE_OVERLAP)
        notes.push(`titles ${a.id} and ${b.id} are near-identical hypotheses`);
  return notes;
};

const validateHookContract = (contract: HookContract): void => {
  const second = (n: number) => Number.isInteger(n) && n >= 1 && n <= 60;
  if (
    !second(contract.proofOrTensionBySecond) ||
    !second(contract.firstOpenLoopBySecond) ||
    !second(contract.firstPartialPayoffBySecond) ||
    contract.firstOpenLoopBySecond >= contract.firstPartialPayoffBySecond
  )
    throw new EpisodeIdeaError("hook_contract_invalid");
};

const touch = (idea: EpisodeIdea, now: Date, change: Partial<EpisodeIdea>): EpisodeIdea =>
  Object.freeze({ ...idea, ...change, updatedAt: now });
const refuse = (): never => {
  throw new EpisodeIdeaError("invalid_transition");
};

export const recordPackaging = (
  idea: EpisodeIdea,
  variants: readonly PackagingVariant[],
  profile: PackagingProfile,
  now: Date,
): EpisodeIdea => {
  if (idea.status !== "idea" && idea.status !== "packaging") refuse();
  checkVariantSet(variants);
  const { selectedVariantId: _s, hookContract: _h, ...rest } = idea;
  return touch(rest as EpisodeIdea, now, {
    status: "packaging",
    packaging: Object.freeze([...variants]),
    packagingChecks: Object.freeze(
      variants.map((v) => Object.freeze({ variantId: v.id, ...checkPackagingVariant(v, profile) })),
    ),
  });
};

export type IdeaDecision = Readonly<{
  decision: "approve" | "revise" | "reject";
  variantId?: string | undefined;
  hookContract?: HookContract | undefined;
  note?: string | undefined;
}>;
export const decideIdea = (idea: EpisodeIdea, input: IdeaDecision, now: Date): EpisodeIdea => {
  const note = input.note?.trim();
  const withNote = note ? { decisionNote: note } : {};
  if (input.decision === "reject") {
    // in_production is not rejectable: the work already exists; archive it instead.
    if (["rejected", "archived", "in_production"].includes(idea.status)) refuse();
    return touch(idea, now, { status: "rejected", ...withNote });
  }
  if (idea.status !== "packaging") return refuse();
  if (input.decision === "revise") return touch(idea, now, withNote);
  const variantId = input.variantId;
  const checks = idea.packagingChecks?.find((c) => c.variantId === variantId);
  if (!checks || !idea.packaging?.some((v) => v.id === variantId))
    throw new EpisodeIdeaError("unknown_variant");
  if (checks.duplicateMessage) throw new EpisodeIdeaError("duplicate_message");
  if (!input.hookContract) throw new EpisodeIdeaError("hook_contract_missing");
  validateHookContract(input.hookContract);
  return touch(idea, now, {
    status: "approved",
    selectedVariantId: checks.variantId,
    hookContract: input.hookContract,
    ...withNote,
  });
};

export const startProduction = (
  idea: EpisodeIdea,
  contentItemId: string,
  now: Date,
): EpisodeIdea =>
  idea.status === "approved"
    ? touch(idea, now, { status: "in_production", contentItemId })
    : refuse();

export const archiveIdea = (idea: EpisodeIdea, now: Date): EpisodeIdea =>
  touch(idea, now, { status: "archived" });
