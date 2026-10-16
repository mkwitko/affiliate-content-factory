import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../channels/channel.js";
import type { ContentVariant } from "../content/content.js";
import {
  assertManualPublicationVariant,
  manualPublicationIdempotencyKey,
  recordManualPublication,
  STORY_STICKER_TEXT,
} from "./manual-publication.js";
import type { CreateManualPublicationInput, PublicationAttemptRepository } from "./publication.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const channel: Channel = {
  id: "ch1",
  workspaceId,
  connectionId: "co1",
  kind: "instagram_stories",
  label: "Stories",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 1000,
  },
};
const variant: ContentVariant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1"],
  caption: "x",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
  approval: {
    id: "approval-1",
    workspaceId,
    variantId: "v1",
    actorId: "owner-1",
    assetChecksums: ["sha256:a1"],
    offerSnapshotId: "s1",
    publicationFingerprint: null,
    policyVersion: 1,
    decidedAt: new Date(),
  },
};

const { approval: _approval, ...unapprovedVariant } = variant;
const draftVariant: ContentVariant = { ...unapprovedVariant, state: "draft" };

describe("STORY_STICKER_TEXT", () => {
  it("is the fixed sticker text", () => {
    expect(STORY_STICKER_TEXT).toBe("Ver oferta");
  });
});

describe("manualPublicationIdempotencyKey", () => {
  it("is namespaced per variant", () => {
    expect(manualPublicationIdempotencyKey("v1")).toBe("manual:v1");
  });
});

describe("assertManualPublicationVariant", () => {
  it("passes for an approved instagram_stories variant", () => {
    expect(() => assertManualPublicationVariant(variant, channel)).not.toThrow();
  });

  it("passes for an approved tiktok_video variant", () => {
    const tiktokChannel = { ...channel, kind: "tiktok_video" as const };
    expect(() => assertManualPublicationVariant(variant, tiktokChannel)).not.toThrow();
  });

  it("throws channel_not_manual for a channel kind with no manual path", () => {
    expect(() => assertManualPublicationVariant(variant, { ...channel, kind: "threads" })).toThrow(
      "channel_not_manual",
    );
  });

  it("throws content_not_approved for an unapproved variant", () => {
    expect(() => assertManualPublicationVariant(draftVariant, channel)).toThrow(
      "content_not_approved",
    );
  });
});

describe("recordManualPublication", () => {
  const attempts = (): PublicationAttemptRepository =>
    ({
      createOrFindManualPublication: vi.fn(async (input: CreateManualPublicationInput) => ({
        created: true,
        attempt: {
          attemptId: input.attemptId,
          workspaceId: input.workspaceId,
          contentVariantId: input.contentVariantId,
          channelId: input.channelId,
          connectionId: input.connectionId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          correlationId: input.correlationId,
          status: "published" as const,
          attemptCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      })),
    }) as unknown as PublicationAttemptRepository;

  it("delegates a manually-recorded publication to the repository with a per-variant key", async () => {
    const repository = attempts();
    const result = await recordManualPublication({
      workspaceId,
      variant,
      channel,
      attempts: repository,
      attemptId: "attempt-1",
      requestFingerprint: "sha256:fp",
      correlationId: "correlation-1",
      publishedAt: new Date("2026-09-24T12:00:00Z"),
    });
    expect(result).toMatchObject({ created: true, attempt: { status: "published" } });
    expect(repository.createOrFindManualPublication).toHaveBeenCalledWith(
      expect.objectContaining({
        contentVariantId: "v1",
        channelId: "ch1",
        connectionId: "co1",
        idempotencyKey: "manual:v1",
      }),
    );
  });

  it("rejects an unapproved variant before calling the repository", async () => {
    const repository = attempts();
    await expect(
      recordManualPublication({
        workspaceId,
        variant: draftVariant,
        channel,
        attempts: repository,
        attemptId: "attempt-1",
        requestFingerprint: "sha256:fp",
        correlationId: "correlation-1",
        publishedAt: new Date(),
      }),
    ).rejects.toThrow("content_not_approved");
    expect(repository.createOrFindManualPublication).not.toHaveBeenCalled();
  });

  it("rejects a channel with no manual publication path", async () => {
    const repository = attempts();
    await expect(
      recordManualPublication({
        workspaceId,
        variant,
        channel: { ...channel, kind: "threads" },
        attempts: repository,
        attemptId: "attempt-1",
        requestFingerprint: "sha256:fp",
        correlationId: "correlation-1",
        publishedAt: new Date(),
      }),
    ).rejects.toThrow("channel_not_manual");
  });

  it("accepts an approved tiktok_video variant", async () => {
    const repository = attempts();
    const tiktokChannel = { ...channel, kind: "tiktok_video" as const };
    const result = await recordManualPublication({
      workspaceId,
      variant,
      channel: tiktokChannel,
      attempts: repository,
      attemptId: "attempt-1",
      requestFingerprint: "sha256:fp",
      correlationId: "correlation-1",
      publishedAt: new Date("2026-09-24T12:00:00Z"),
    });
    expect(result).toMatchObject({ created: true, attempt: { status: "published" } });
  });
});
