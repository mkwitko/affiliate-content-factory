import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { PublicationAttempt } from "../publishing/publication.js";
import type { ContentItem, ContentVariant } from "./content.js";
import { cancelContentItem, pendingNextAction } from "./pending.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const variant = (state: ContentVariant["state"]): ContentVariant => ({
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "x",
  language: "pt-BR",
  state,
  voiceScript: [],
});
const attempt = (status: PublicationAttempt["status"]): PublicationAttempt => ({
  attemptId: "at1",
  workspaceId,
  contentVariantId: "v1",
  channelId: "ch1",
  connectionId: "co1",
  idempotencyKey: "k",
  requestFingerprint: "f",
  correlationId: "c",
  status,
  attemptCount: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("pendingNextAction", () => {
  it("maps each pending condition, first match wins", () => {
    expect(pendingNextAction(variant("approved"), attempt("queued"))).toBe("wait");
    expect(pendingNextAction(variant("approved"), attempt("publishing"))).toBe("wait");
    expect(pendingNextAction(variant("approved"), attempt("retryable_failure"))).toBe("wait");
    expect(pendingNextAction(variant("approved"), attempt("unknown_outcome"))).toBe("reconcile");
    expect(pendingNextAction(variant("approved"), null)).toBe("publish");
    expect(pendingNextAction(variant("approved"), attempt("permanent_failure"))).toBe("publish");
    expect(pendingNextAction(variant("rejected"), null)).toBe("rebuild");
    expect(pendingNextAction(variant("draft"), null)).toBe("approve");
    expect(pendingNextAction(variant("ready_for_review"), null)).toBe("approve");
  });

  it("routes an approved instagram_stories variant to manual_story instead of publish", () => {
    expect(pendingNextAction(variant("approved"), null, "instagram_stories")).toBe("manual_story");
    expect(
      pendingNextAction(variant("approved"), attempt("permanent_failure"), "instagram_stories"),
    ).toBe("manual_story");
    expect(pendingNextAction(variant("approved"), null, "threads")).toBe("publish");
    // A publication attempt still in flight (e.g. a leftover from before this channel kind was
    // made manual-only) takes priority over the channel kind.
    expect(pendingNextAction(variant("approved"), attempt("queued"), "instagram_stories")).toBe(
      "wait",
    );
  });

  it("routes an approved tiktok_video variant to publish, which sends a TikTok draft", () => {
    expect(pendingNextAction(variant("approved"), null, "tiktok_video")).toBe("publish");
    expect(pendingNextAction(variant("approved"), attempt("queued"), "tiktok_video")).toBe("wait");
  });

  it("excludes finished variants", () => {
    expect(pendingNextAction(variant("published"), attempt("published"))).toBeNull();
    expect(pendingNextAction(variant("approved"), attempt("published"))).toBeNull();
    expect(pendingNextAction(variant("cancelled"), null)).toBeNull();
    expect(pendingNextAction(variant("scheduled"), null)).toBeNull();
  });
});

describe("cancelContentItem", () => {
  const item: ContentItem = {
    id: "c1",
    workspaceId,
    nicheId: "n1",
    offerId: "o1",
    offerSnapshotId: "s1",
    title: "Post",
    sourceFactKeys: [],
    creativeOpinion: "x",
    state: "draft",
  };

  it("cancels a draft content item", () => {
    expect(cancelContentItem(item).state).toBe("cancelled");
  });

  it("refuses an item that is already cancelled", () => {
    expect(() => cancelContentItem({ ...item, state: "cancelled" })).toThrow(
      "Only draft content items can be cancelled",
    );
  });
});
