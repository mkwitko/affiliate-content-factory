import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { AuditEvent } from "@money-maker/core/audit/audit-port";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { PublicationAttempt } from "@money-maker/core/publishing/publication";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { cancelContentTool } from "./cancel-content.js";
import { rejectContentTool } from "./reject-content.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const variant: ContentVariant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "x",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
};
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

const fixture = (
  current: ContentVariant,
  latest: PublicationAttempt | null,
  role: "owner" | "reviewer" = "owner",
  orphans: readonly ContentItem[] = [],
) => {
  const updated: ContentVariant[] = [];
  const cancelledItems: string[] = [];
  const audited: AuditEvent[] = [];
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
      addMembership: async () => undefined,
    },
    audit: {
      record: async (event) => {
        audited.push(event);
        return "audit-1";
      },
    },
    contentRepository: {
      listContentItemsWithoutActiveVariants: async (_workspaceId, options) =>
        orphans.filter((entry) => options?.contentItemIds?.includes(entry.id) ?? true),
      updateContentItemState: async ({ contentItemId, state }) => {
        cancelledItems.push(contentItemId);
        return { ...item, id: contentItemId, state };
      },
      createContentItem: async (value) => value,
      findContentItemForWorkspace: async () => null,
      createVariant: async (value) => value,
      listVariantsForWorkspace: async () => [current],
      findVariantForWorkspace: async () => current,
      findReviewableForWorkspace: async () => [],
      updateVariant: async (value) => {
        updated.push(value);
        return value;
      },
      updateContentItem: async (item) => item,
      recordApproval: async ({ variant: value }) => value,
    },
    publicationAttempts: {
      listLatestForVariants: async () => new Map(latest ? [[current.id, latest] as const] : []),
    } as unknown as NonNullable<McpDependencies["publicationAttempts"]>,
  };
  return { dependencies, updated, audited, cancelledItems };
};

const cancel = (dependencies: McpDependencies, reason = "duplicate post") =>
  cancelContentTool({ workspaceId, variantId: "v1", reason }, actorId, dependencies);

describe("cancel_content", () => {
  it("cancels a draft with a reason and records an audit event", async () => {
    const { dependencies, updated, audited } = fixture(variant, null);
    const result = await cancel(dependencies);
    expect(result.ok).toBe(true);
    expect(updated[0]).toMatchObject({
      state: "cancelled",
      rejectionReason: "duplicate post",
      assetIds: ["a1"],
    });
    expect(audited[0]).toMatchObject({
      action: "content.cancelled",
      targetType: "content_variant",
      targetId: "v1",
    });
  });

  it("refuses while the queue may still publish", async () => {
    for (const status of [
      "queued",
      "publishing",
      "retryable_failure",
      "unknown_outcome",
    ] as const) {
      const { dependencies, updated, audited } = fixture(
        { ...variant, state: "approved" },
        attempt(status),
      );
      await expect(cancel(dependencies)).resolves.toEqual({
        ok: false,
        error: "PUBLICATION_STILL_UNKNOWN",
      });
      expect(updated).toHaveLength(0);
      expect(audited).toHaveLength(0);
    }
  });

  it("cancels a scheduled post still waiting in the queue, but not one about to go out", async () => {
    const later = fixture(
      { ...variant, state: "approved" },
      { ...attempt("queued"), scheduledAt: new Date(Date.now() + 60 * 60 * 1000) },
    );
    await expect(cancel(later.dependencies)).resolves.toMatchObject({ ok: true });
    expect(later.updated[0]).toMatchObject({ state: "cancelled" });
    const imminent = fixture(
      { ...variant, state: "approved" },
      { ...attempt("queued"), scheduledAt: new Date(Date.now() + 30 * 1000) },
    );
    await expect(cancel(imminent.dependencies)).resolves.toEqual({
      ok: false,
      error: "PUBLICATION_STILL_UNKNOWN",
    });
  });

  it("allows cancel after a permanent failure", async () => {
    const { dependencies } = fixture(
      { ...variant, state: "approved" },
      attempt("permanent_failure"),
    );
    await expect(cancel(dependencies)).resolves.toMatchObject({ ok: true });
  });

  it("refuses to cancel a live post (approved variant whose latest attempt is published)", async () => {
    const { dependencies, updated } = fixture(
      { ...variant, state: "approved" },
      attempt("published"),
    );
    await expect(cancel(dependencies)).resolves.toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(updated).toHaveLength(0);
  });

  it("returns INVALID_CONTENT for a published variant", async () => {
    const { dependencies, updated } = fixture(
      { ...variant, state: "published" },
      attempt("published"),
    );
    await expect(cancel(dependencies)).resolves.toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(updated).toHaveLength(0);
  });

  it("forbids reviewers", async () => {
    const { dependencies } = fixture(variant, null, "reviewer");
    await expect(cancel(dependencies)).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("cancel_content for a post without variants", () => {
  it("cancels a content item that never got an active variant", async () => {
    const { dependencies, cancelledItems, audited } = fixture(variant, null, "owner", [item]);
    const result = await cancelContentTool(
      { workspaceId, contentItemId: "c1", reason: "abandoned" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { contentItem: { id: "c1", state: "cancelled" } },
    });
    expect(cancelledItems).toEqual(["c1"]);
    expect(audited[0]).toMatchObject({
      action: "content.cancelled",
      targetType: "content_item",
      targetId: "c1",
    });
  });

  it("refuses an item that still has an active variant", async () => {
    const { dependencies, cancelledItems } = fixture(variant, null, "owner", []);
    const result = await cancelContentTool(
      { workspaceId, contentItemId: "c1", reason: "abandoned" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_CONTENT" });
    expect(cancelledItems).toHaveLength(0);
  });

  it("requires exactly one of variantId or contentItemId", async () => {
    const { dependencies } = fixture(variant, null);
    for (const args of [
      { workspaceId, reason: "x" },
      { workspaceId, variantId: "v1", contentItemId: "c1", reason: "x" },
    ]) {
      await expect(cancelContentTool(args, actorId, dependencies)).resolves.toEqual({
        ok: false,
        error: "INVALID_ARGUMENTS",
      });
    }
  });
});

describe("reject_content from draft", () => {
  it("rejects a never-submitted draft, matching approve_content", async () => {
    const { dependencies, updated } = fixture(variant, null);
    const result = await rejectContentTool(
      { workspaceId, variantId: "v1", reason: "wrong angle" },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(updated[0]).toMatchObject({ state: "rejected", rejectionReason: "wrong angle" });
  });

  it("stores typed reasons before the note and refuses an empty rejection", async () => {
    const { dependencies, updated } = fixture(variant, null);
    const result = await rejectContentTool(
      { workspaceId, variantId: "v1", reasons: ["BAD_PRODUCT", "AI_LOOK"], reason: "tampa" },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
    expect(updated[0]).toMatchObject({ rejectionReason: "BAD_PRODUCT, AI_LOOK: tampa" });
    expect(
      await rejectContentTool({ workspaceId, variantId: "v1", reason: " " }, actorId, dependencies),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(
      await rejectContentTool(
        { workspaceId, variantId: "v1", reasons: ["NOPE"] },
        actorId,
        dependencies,
      ),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
