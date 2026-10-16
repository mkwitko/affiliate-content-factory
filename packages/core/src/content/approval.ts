import type { UserId, WorkspaceId } from "@money-maker/contracts";
import type { ContentVariant, VariantApproval } from "./content.js";
import type { PrepublishScore } from "./prepublish-score.js";

export type ApprovalDecision = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  variantId: string;
  actorId: UserId;
  assetChecksums: readonly string[];
  offerSnapshotId: string | null;
  publicationFingerprint: string | null;
  legacy?: true;
  policyVersion: number;
  decidedAt: Date;
}>;

export type ApprovalResult =
  | Readonly<{ ok: true; variant: ContentVariant }>
  | Readonly<{
      ok: false;
      code:
        | "not_ready_for_review"
        | "workspace_mismatch"
        | "binding_mismatch"
        | "fidelity_blocked"
        | "quality_blocked"
        | "prepublish_blocked"
        | "invalid_decision";
    }>
  | Readonly<{ ok: false; code: "generated_clip_rights_unverified"; assetId: string }>
  | Readonly<{ ok: false; code: "ai_disclosure_missing" }>;

const validDate = (value: Date): boolean => !Number.isNaN(value.getTime());

const freezeDecision = (decision: ApprovalDecision): VariantApproval => {
  if (decision.id.trim().length === 0 || decision.variantId.trim().length === 0) {
    throw new Error("Approval decision identifiers are required");
  }
  if (
    decision.assetChecksums.length === 0 ||
    decision.assetChecksums.some((checksum) => checksum.trim().length === 0)
  ) {
    throw new Error("Approval asset checksums are required");
  }
  if (!Number.isInteger(decision.policyVersion) || decision.policyVersion < 1) {
    throw new Error("Approval policy version is invalid");
  }
  if (!validDate(decision.decidedAt)) throw new Error("Approval decision time is invalid");
  if (
    (decision.publicationFingerprint === null && decision.legacy !== true) ||
    (decision.publicationFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(decision.publicationFingerprint))
  )
    throw new Error("Approval publication fingerprint is invalid");
  return Object.freeze({
    ...decision,
    assetChecksums: Object.freeze([...decision.assetChecksums]),
  });
};

export const submitForReview = (variant: ContentVariant): ContentVariant => {
  if (variant.state !== "draft" && variant.state !== "rejected") {
    throw new Error("Only draft or rejected variants can be submitted for review");
  }
  const { rejectionReason: _rejectionReason, ...withoutRejection } = variant;
  return Object.freeze({ ...withoutRejection, state: "ready_for_review" as const });
};

export const approveVariant = (
  variant: ContentVariant,
  decision: ApprovalDecision,
  options: Readonly<{
    prepublish?: Pick<PrepublishScore, "verdict">;
    /** A stored scene clip in the variant's asset lineage whose rights are not verified. */
    unverifiedClipAssetId?: string | undefined;
    /** The lineage holds a generated clip and the caption has no AI disclosure (Agnes ToS 6.1). */
    aiDisclosureMissing?: boolean | undefined;
  }> = {},
): ApprovalResult => {
  if (variant.state !== "ready_for_review") return { ok: false, code: "not_ready_for_review" };
  if (variant.workspaceId !== decision.workspaceId)
    return { ok: false, code: "workspace_mismatch" };
  if (variant.id !== decision.variantId || variant.offerSnapshotId !== decision.offerSnapshotId) {
    return { ok: false, code: "binding_mismatch" };
  }
  // Fail closed: anything but a stored pass or warn (block, or a malformed row) refuses approval.
  // Absent means no fidelity QA ran; a present value must be a well-formed pass or warn throughout.
  const creativeRender = variant.creativeRender;
  if (creativeRender && "fidelity" in creativeRender) {
    const fidelity = creativeRender.fidelity as unknown as
      | { verdict?: unknown; slides?: unknown }
      | null
      | undefined;
    const readable = (verdict: unknown) => verdict === "pass" || verdict === "warn";
    if (
      !fidelity ||
      !readable(fidelity.verdict) ||
      !Array.isArray(fidelity.slides) ||
      !fidelity.slides.every(
        (slide: unknown) =>
          typeof slide === "object" &&
          slide !== null &&
          readable((slide as { verdict?: unknown }).verdict),
      )
    )
      return { ok: false, code: "fidelity_blocked" };
  }
  // Same fail-closed rule for legibility QA: only a well-formed pass or warn approves.
  if (creativeRender && "quality" in creativeRender) {
    const quality = creativeRender.quality as unknown as
      | { verdict?: unknown; slides?: unknown }
      | null
      | undefined;
    const readable = (verdict: unknown) => verdict === "pass" || verdict === "warn";
    if (
      !quality ||
      !readable(quality.verdict) ||
      !Array.isArray(quality.slides) ||
      !quality.slides.every(
        (slide: unknown) =>
          typeof slide === "object" &&
          slide !== null &&
          readable((slide as { verdict?: unknown }).verdict),
      )
    )
      return { ok: false, code: "quality_blocked" };
  }
  if (options.aiDisclosureMissing === true) return { ok: false, code: "ai_disclosure_missing" };
  if (options.unverifiedClipAssetId !== undefined)
    return {
      ok: false,
      code: "generated_clip_rights_unverified",
      assetId: options.unverifiedClipAssetId,
    };
  if (options.prepublish?.verdict === "block") return { ok: false, code: "prepublish_blocked" };
  try {
    const approval = freezeDecision(decision);
    return {
      ok: true,
      variant: Object.freeze({ ...variant, state: "approved" as const, approval }),
    };
  } catch {
    return { ok: false, code: "invalid_decision" };
  }
};

/** Typed review reasons: labels for the arena, Jev shadow metrics and the feedback dataset. */
export const REVIEW_REASONS = [
  "BAD_PRODUCT",
  "BAD_FACE",
  "BAD_HAND",
  "BAD_CHARACTER",
  "BAD_COPY",
  "BAD_HOOK",
  "BAD_LAYOUT",
  "BAD_TEXT",
  "BAD_VOICE",
  "BAD_MUSIC",
  "BAD_CAPTIONS",
  "BAD_MOTION",
  "BAD_PACING",
  "AI_LOOK",
  "OTHER",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

const REASON_PREFIX = /^((?:[A-Z_]+)(?:, [A-Z_]+)*)(?::\s*|$)/;

/**
 * Codes travel inside the existing free-text reason as a "BAD_PRODUCT, AI_LOOK: note" prefix, so
 * old rows and clients keep working without a migration. ponytail: text prefix; move to a column
 * when reasons are queried in SQL.
 */
export const rejectionText = (reasons: readonly ReviewReason[], note: string): string => {
  const codes = [...new Set(reasons)].join(", ");
  const text = note.trim();
  return codes ? (text ? `${codes}: ${text}` : codes) : text;
};

/** Leading review codes of a stored reason; free text without a valid prefix yields none. */
export const rejectionCodes = (text: string): readonly ReviewReason[] => {
  const match = REASON_PREFIX.exec(text.trim());
  if (!match?.[1]) return [];
  const codes = match[1].split(", ");
  return codes.every((code) => (REVIEW_REASONS as readonly string[]).includes(code))
    ? (codes as ReviewReason[])
    : [];
};

export const rejectVariant = (variant: ContentVariant, reason: string): ContentVariant => {
  if (variant.state !== "ready_for_review") {
    throw new Error("Only reviewable variants can be rejected");
  }
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) throw new Error("Rejection reason is required");
  return Object.freeze({
    ...variant,
    state: "rejected" as const,
    rejectionReason: normalizedReason,
  });
};

export const invalidateApproval = (
  variant: ContentVariant,
  currentAssetChecksums: readonly string[] | string,
  currentFingerprint?: string,
): ContentVariant => {
  if (variant.state !== "approved" || !variant.approval) return variant;
  const current =
    typeof currentAssetChecksums === "string" ? [currentAssetChecksums] : currentAssetChecksums;
  if (
    (currentFingerprint === undefined ||
      currentFingerprint === variant.approval.publicationFingerprint) &&
    current.length === variant.approval.assetChecksums.length &&
    current.every((checksum, index) => checksum === variant.approval?.assetChecksums[index])
  ) {
    return variant;
  }
  const { approval: _approval, ...withoutApproval } = variant;
  return Object.freeze({ ...withoutApproval, state: "ready_for_review" as const });
};

const cancellableStates: ReadonlySet<ContentVariant["state"]> = new Set([
  "draft",
  "ready_for_review",
  "rejected",
  "approved",
]);

/** Soft cancel: the row stays for audit and its assets stay immutable. */
export const cancelVariant = (variant: ContentVariant, reason: string): ContentVariant => {
  if (!cancellableStates.has(variant.state)) {
    throw new Error("Only unfinished variants can be cancelled");
  }
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0) throw new Error("Cancellation reason is required");
  return Object.freeze({
    ...variant,
    state: "cancelled" as const,
    rejectionReason: normalizedReason,
  });
};
