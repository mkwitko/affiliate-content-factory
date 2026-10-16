import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  type ApprovalDecision,
  approveVariant,
  cancelVariant,
  invalidateApproval,
  rejectionCodes,
  rejectionText,
  rejectVariant,
  submitForReview,
} from "./approval.js";
import type { ContentVariant } from "./content.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("33333333-3333-4333-8333-333333333333");

const draftVariant = (state: ContentVariant["state"] = "draft"): ContentVariant => ({
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: "channel-1",
  offerSnapshotId: "snapshot-1",
  assetIds: ["asset-1"],
  caption: "A useful product idea.",
  language: "pt-BR",
  state,
  voiceScript: [],
});

const decision: ApprovalDecision = {
  id: "approval-1",
  workspaceId,
  variantId: "variant-1",
  actorId,
  assetChecksums: ["checksum-1"],
  offerSnapshotId: "snapshot-1",
  publicationFingerprint: "a".repeat(64),
  policyVersion: 1,
  decidedAt: new Date("2026-09-21T12:00:00.000Z"),
};

describe("content approval domain", () => {
  it("does not approve a draft before it is submitted for review", () => {
    expect(approveVariant(draftVariant(), decision)).toEqual({
      ok: false,
      code: "not_ready_for_review",
    });
  });

  it("approves a reviewable variant with exact evidence bindings", () => {
    const reviewable = submitForReview(draftVariant());

    expect(approveVariant(reviewable, decision)).toMatchObject({
      ok: true,
      variant: {
        state: "approved",
        approval: decision,
      },
    });
  });

  it("drops the rejection reason when a rejected variant is submitted and approved", () => {
    const rejected = { ...draftVariant("rejected"), rejectionReason: "typo" };
    const result = approveVariant(submitForReview(rejected), decision);
    if (!result.ok) throw new Error("expected approval");
    expect(result.variant.rejectionReason).toBeUndefined();
  });

  it("rejects a reviewable variant with a required reason", () => {
    const reviewable = submitForReview(draftVariant());

    expect(rejectVariant(reviewable, "The claim needs a clearer source")).toMatchObject({
      state: "rejected",
      rejectionReason: "The claim needs a clearer source",
    });
  });

  it("invalidates approval when an approved asset checksum changes", () => {
    const approved = approveVariant(submitForReview(draftVariant()), decision);
    if (!approved.ok) throw new Error("Expected approval");

    expect(invalidateApproval(approved.variant, ["checksum-2"])).toMatchObject({
      state: "ready_for_review",
    });
    expect(invalidateApproval(approved.variant, ["checksum-1"])).toEqual(approved.variant);
  });

  it("invalidates approval when the canonical publication payload changes", () => {
    const approved = approveVariant(submitForReview(draftVariant()), decision);
    if (!approved.ok) throw new Error("Expected approval");
    expect(invalidateApproval(approved.variant, ["checksum-1"], "b".repeat(64))).toMatchObject({
      state: "ready_for_review",
    });
    expect(invalidateApproval(approved.variant, ["checksum-1"], "a".repeat(64))).toEqual(
      approved.variant,
    );
  });

  it("refuses a fidelity-blocked or unreadable fidelity report and allows warn", () => {
    const rendered = (verdict: string): ContentVariant =>
      submitForReview({
        ...draftVariant(),
        creativeRender: {
          state: "rendered",
          templateVersions: {},
          rendererVersion: 1,
          brandKitHash: "hash",
          fidelity: { verdict, slides: [] } as unknown as NonNullable<
            NonNullable<ContentVariant["creativeRender"]>["fidelity"]
          >,
        },
      });
    expect(approveVariant(rendered("block"), decision)).toEqual({
      ok: false,
      code: "fidelity_blocked",
    });
    expect(approveVariant(rendered("BLOCK?"), decision)).toEqual({
      ok: false,
      code: "fidelity_blocked",
    });
    const withFidelity = (fidelity: unknown): ContentVariant =>
      submitForReview({
        ...draftVariant(),
        creativeRender: {
          state: "rendered",
          templateVersions: {},
          rendererVersion: 1,
          brandKitHash: "hash",
          fidelity: fidelity as NonNullable<
            NonNullable<ContentVariant["creativeRender"]>["fidelity"]
          >,
        },
      });
    // A stored null or a pass summary over a blocked slide is malformed: fail closed.
    expect(approveVariant(withFidelity(null), decision)).toEqual({
      ok: false,
      code: "fidelity_blocked",
    });
    expect(
      approveVariant(
        withFidelity({ verdict: "pass", slides: [{ slideIndex: 1, verdict: "block" }] }),
        decision,
      ),
    ).toEqual({ ok: false, code: "fidelity_blocked" });
    expect(approveVariant(rendered("warn"), decision)).toMatchObject({ ok: true });
    expect(approveVariant(rendered("pass"), decision)).toMatchObject({ ok: true });
  });

  it("refuses a blocked or malformed legibility report and allows pass and warn", () => {
    const withQuality = (quality: unknown): ContentVariant =>
      submitForReview({
        ...draftVariant(),
        creativeRender: {
          state: "rendered",
          templateVersions: {},
          rendererVersion: 1,
          brandKitHash: "hash",
          quality: quality as NonNullable<NonNullable<ContentVariant["creativeRender"]>["quality"]>,
        },
      });
    const slide = (verdict: string) => ({ slideIndex: 1, verdict, score: 50 });
    const refused = { ok: false, code: "quality_blocked" };
    expect(approveVariant(withQuality({ verdict: "block", slides: [] }), decision)).toEqual(
      refused,
    );
    expect(approveVariant(withQuality(null), decision)).toEqual(refused);
    expect(
      approveVariant(withQuality({ verdict: "pass", slides: [slide("block")] }), decision),
    ).toEqual(refused);
    expect(
      approveVariant(withQuality({ verdict: "warn", slides: [slide("warn")] }), decision),
    ).toMatchObject({ ok: true });
  });

  it("rejects approval decisions from another workspace", () => {
    const otherDecision = {
      ...decision,
      workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
    };

    expect(approveVariant(submitForReview(draftVariant()), otherDecision)).toEqual({
      ok: false,
      code: "workspace_mismatch",
    });
  });
});

describe("cancelVariant", () => {
  it("cancels unfinished variants and keeps the reason", () => {
    for (const state of ["draft", "ready_for_review", "rejected", "approved"] as const) {
      const cancelled = cancelVariant(draftVariant(state), " duplicate ");
      expect(cancelled.state).toBe("cancelled");
      expect(cancelled.rejectionReason).toBe("duplicate");
    }
  });

  it("refuses to cancel finished variants", () => {
    for (const state of ["published", "cancelled", "scheduled"] as const) {
      expect(() => cancelVariant(draftVariant(state), "x")).toThrow(
        "Only unfinished variants can be cancelled",
      );
    }
  });

  it("requires a reason", () => {
    expect(() => cancelVariant(draftVariant(), "  ")).toThrow("Cancellation reason is required");
  });
});

describe("pre-publish gate", () => {
  it("refuses a blocked pre-publish score and approves pass or warn", () => {
    const reviewable = submitForReview(draftVariant());
    expect(approveVariant(reviewable, decision, { prepublish: { verdict: "block" } })).toEqual({
      ok: false,
      code: "prepublish_blocked",
    });
    expect(approveVariant(reviewable, decision, { prepublish: { verdict: "warn" } }).ok).toBe(true);
    expect(approveVariant(reviewable, decision, { prepublish: { verdict: "pass" } }).ok).toBe(true);
  });
});

describe("generated scene clip rights gate", () => {
  it("refuses approval while a scene clip in the lineage has unverified rights, on any channel", () => {
    const reviewable = submitForReview(draftVariant());
    expect(approveVariant(reviewable, decision, { unverifiedClipAssetId: "clip-1" })).toEqual({
      ok: false,
      code: "generated_clip_rights_unverified",
      assetId: "clip-1",
    });
  });
  it("refuses a variant built on a generated clip whose caption has no AI disclosure (Agnes ToS 6.1)", () => {
    const reviewable = submitForReview(draftVariant());
    expect(approveVariant(reviewable, decision, { aiDisclosureMissing: true })).toEqual({
      ok: false,
      code: "ai_disclosure_missing",
    });
  });
  it("reports the missing disclosure before unverified clip rights", () => {
    const reviewable = submitForReview(draftVariant());
    expect(
      approveVariant(reviewable, decision, {
        aiDisclosureMissing: true,
        unverifiedClipAssetId: "clip-1",
      }),
    ).toMatchObject({ code: "ai_disclosure_missing" });
  });
  it("approves when no clip is unverified", () => {
    const reviewable = submitForReview(draftVariant());
    expect(approveVariant(reviewable, decision, {})).toMatchObject({ ok: true });
  });
});

describe("review reason codes", () => {
  it("round-trips codes through the stored reason text", () => {
    const text = rejectionText(["BAD_PRODUCT", "AI_LOOK", "BAD_PRODUCT"], " tampa errada ");
    expect(text).toBe("BAD_PRODUCT, AI_LOOK: tampa errada");
    expect(rejectionCodes(text)).toEqual(["BAD_PRODUCT", "AI_LOOK"]);
    expect(rejectionCodes(rejectionText(["BAD_HOOK"], ""))).toEqual(["BAD_HOOK"]);
  });

  it("reads old free text and unknown codes as no codes", () => {
    expect(rejectionCodes("Preço errado no slide 2")).toEqual([]);
    expect(rejectionCodes("NOT_A_CODE: x")).toEqual([]);
    expect(rejectionText([], "só texto")).toBe("só texto");
  });
});
