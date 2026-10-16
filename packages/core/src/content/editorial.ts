import { createHash, randomUUID } from "node:crypto";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import type { Asset } from "../assets/asset.js";
import type { EpisodeSpec } from "../story/story.js";

export type EvidenceRef =
  | Readonly<{ kind: "commercial_fact"; snapshotId: string; key: string }>
  | Readonly<{ kind: "research_observation"; observationId: string }>;
/**
 * How a claim relates to reality. Only verified facts need evidence; a simplification carries a
 * note saying what it leaves out; analogies, hypotheses and fictional examples are labelled so
 * nothing invented is presented as fact.
 */
export type ClaimKind =
  | "verified_fact"
  | "reasonable_simplification"
  | "analogy"
  | "hypothesis"
  | "fictional_example";
export type Claim = Readonly<{
  text: string;
  kind: ClaimKind;
  note?: string;
  evidence: readonly EvidenceRef[];
}>;
export type ClaimInput = Readonly<{
  text: string;
  kind?: ClaimKind | undefined;
  note?: string | undefined;
  evidence: readonly EvidenceRef[];
}>;
/** Scripts stored before claim kinds existed read as verified facts (they all carried evidence). */
export const withClaimKindDefault = (claims: readonly ClaimInput[]): readonly Claim[] =>
  claims.map((claim) => {
    const note = claim.note?.trim();
    return Object.freeze({
      text: claim.text.trim(),
      kind: claim.kind ?? "verified_fact",
      ...(note ? { note } : {}),
      evidence: Object.freeze(claim.evidence.map((ref) => Object.freeze({ ...ref }))),
    });
  });
export type ScriptBeat = Readonly<{
  kind:
    | "hook"
    | "promise"
    | "open_loop"
    | "payoff"
    | "pattern_interrupt"
    | "chapter"
    | "cta"
    | "number_reveal"
    | "twist"
    | "rehook"
    | "next_video_bridge";
  atChar: number;
  label?: string | undefined;
}>;
export type ContentScript = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  contentItemId: string;
  version: number;
  status: "draft" | "approved";
  body: string;
  language: string;
  claims: readonly Claim[];
  beats: readonly ScriptBeat[];
  checksum: string;
  /** Advisory story plan (spec 13); not part of the checksum. */
  episodePlan?: EpisodeSpec;
  createdAt: Date;
  actorId: UserId;
  approvedBy?: UserId;
  approvedAt?: Date;
  approvedChecksum?: string;
}>;

export const createContentScript = (input: {
  id?: string;
  workspaceId: WorkspaceId;
  contentItemId: string;
  version: number;
  body: string;
  language: string;
  claims: readonly ClaimInput[];
  beats: readonly ScriptBeat[];
  episodePlan?: EpisodeSpec | undefined;
  actorId: UserId;
  createdAt?: Date;
}): ContentScript => {
  const body = input.body.trim();
  if (!body || body.length > 40_000 || !input.language.trim() || input.version < 1)
    throw new Error("invalid_content_script");
  for (const claim of input.claims) {
    const kind = claim.kind ?? "verified_fact";
    if (
      !claim.text.trim() ||
      claim.text.length > 300 ||
      claim.evidence.length > 10 ||
      (kind === "verified_fact" && claim.evidence.length < 1) ||
      (kind === "reasonable_simplification" && !claim.note?.trim())
    )
      throw new Error("invalid_claim");
  }
  if (
    input.beats.some(
      (beat) => !Number.isInteger(beat.atChar) || beat.atChar < 0 || beat.atChar >= body.length,
    )
  )
    throw new Error("invalid_script_beat");
  const claims = Object.freeze(withClaimKindDefault(input.claims));
  const beats = Object.freeze(input.beats.map((beat) => Object.freeze({ ...beat })));
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    contentItemId: input.contentItemId,
    version: input.version,
    status: "draft",
    body,
    language: input.language.trim(),
    claims,
    beats,
    checksum: createHash("sha256").update(body, "utf8").digest("hex"),
    ...(input.episodePlan ? { episodePlan: input.episodePlan } : {}),
    createdAt: input.createdAt ?? new Date(),
    actorId: input.actorId,
  });
};

export type Verdict = "pass" | "fail" | "n/a";
export type EditorialChecklist = Readonly<
  Record<
    | "originalAngle"
    | "meaningfulEditorialInput"
    | "visualVariation"
    | "sourceGrounding"
    | "rightsReviewed"
    | "disclosureDecisionReviewed"
    | "massProductionRisk"
    | "reusedContentRisk"
    | "editorialValueIndependentOfAffiliate",
    Verdict
  >
>;
export const REVIEW_POLICY_VERSION = 1;
export const REVIEW_POLICY_MIN_VERSION = 1;
export type EditorialReview = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  variantId: string;
  publicationFingerprint: string;
  rightsFingerprint: string;
  reviewPolicyVersion: number;
  checklist: EditorialChecklist;
  verdict: "pass" | "fail";
  notes: string;
  reviewerId: UserId;
  decidedAt: Date;
}>;

export const createEditorialReview = (
  input: Omit<EditorialReview, "id" | "reviewPolicyVersion" | "decidedAt"> & {
    id?: string;
    reviewPolicyVersion?: number;
    decidedAt?: Date;
  },
): EditorialReview => {
  const values = Object.values(input.checklist);
  if (
    !/^[a-f0-9]{64}$/.test(input.publicationFingerprint) ||
    values.length !== 9 ||
    values.some((value) => !["pass", "fail", "n/a"].includes(value))
  )
    throw new Error("invalid_editorial_review");
  const verdict = values.includes("fail") ? "fail" : "pass";
  if (input.verdict !== verdict) throw new Error("editorial_review_verdict_mismatch");
  return Object.freeze({
    ...input,
    id: input.id ?? randomUUID(),
    reviewPolicyVersion: input.reviewPolicyVersion ?? REVIEW_POLICY_VERSION,
    decidedAt: input.decidedAt ?? new Date(),
    verdict,
  });
};

export const isCountingEditorialReview = (
  review: EditorialReview | null,
  fingerprint: string,
): boolean =>
  !!review &&
  review.publicationFingerprint === fingerprint &&
  review.verdict === "pass" &&
  review.reviewPolicyVersion >= REVIEW_POLICY_MIN_VERSION;

export const assetRightsFingerprint = (assets: readonly Asset[]): string =>
  createHash("sha256")
    .update(
      JSON.stringify(
        [...assets]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((asset) => ({
            id: asset.id,
            checksum: asset.checksum,
            provenance: asset.provenance,
            license: asset.license,
            sourceUrl: asset.sourceUrl ?? null,
            creator: asset.creator ?? null,
            commercialUse: asset.commercialUse,
          })),
      ),
      "utf8",
    )
    .digest("hex");
