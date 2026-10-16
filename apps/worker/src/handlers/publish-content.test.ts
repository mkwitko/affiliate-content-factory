import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createRedirect,
  TRACKED_LINK_TTL_MS,
  trackedUrl,
} from "@money-maker/core/analytics/attribution";
import type { AttributionRepository } from "@money-maker/core/analytics/attribution-repository";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import { createPublishContentJobPayload } from "@money-maker/core/jobs/job";
import type {
  MarketplaceCatalog,
  ProductEvidence,
} from "@money-maker/core/offers/marketplace-catalog";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { SocialPublisher } from "@money-maker/core/publishing/social-publisher";
import { describe, expect, it, vi } from "vitest";
import { createPublishContentHandler, type PublishContentDependencies } from "./publish-content.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://workspace/pfm",
  accountId: "account-1",
  displayName: "exampleshop.home",
  status: "active",
};
const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: connection.id,
  kind: "threads",
  label: "Threads",
  status: "active",
  capabilities: {
    maxAssets: 1,
    requiresOrderedAssets: false,
    allowedMimeTypes: [],
    captionMaxLength: 500,
  },
};
const variant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: "content-1",
  channelId: channel.id,
  offerSnapshotId: "snapshot-1",
  assetIds: [],
  caption: "Approved copy",
  language: "pt-BR",
  state: "approved",
  voiceScript: [],
  approval: {
    id: "approval-1",
    workspaceId,
    variantId: "variant-1",
    actorId: "owner-1",
    assetChecksums: [],
    offerSnapshotId: "snapshot-1",
    publicationFingerprint: null,
    policyVersion: 1,
    decidedAt: new Date("2026-09-21T12:00:00.000Z"),
  },
};
const sourceUrl = "https://www.mercadolivre.com.br/p/MLB1";
const commercialSnapshot = {
  id: "snapshot-1",
  verifiedAt: new Date(),
  facts: [
    {
      key: "current_price",
      value: { amountMinor: 19700, currency: "BRL" },
      sourceUrl,
      verified: true,
    },
    { key: "listing_status", value: "active", sourceUrl, verified: true },
    { key: "availability", value: "available", sourceUrl, verified: true },
  ],
};
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: sourceUrl,
  affiliateUrl: "https://meli.la/a",
  title: "Product",
  state: "active",
  snapshots: [commercialSnapshot],
  activeSnapshotId: commercialSnapshot.id,
};
const contentItem: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: "niche-1",
  offerId: offer.id,
  offerSnapshotId: commercialSnapshot.id,
  title: "Content",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "A practical angle.",
  state: "draft",
};
const refreshedEvidence = (overrides: Partial<ProductEvidence> = {}): ProductEvidence => ({
  providerId: "MLB1",
  title: "Product",
  listingUrl: new URL(sourceUrl),
  seller: "seller",
  availability: "available",
  listingStatus: "active",
  currentPrice: { amountMinor: 19700, currency: "BRL" },
  observedAt: new Date(),
  ...overrides,
});
const attempt: PublicationAttempt = {
  attemptId: "attempt-1",
  workspaceId,
  contentVariantId: variant.id,
  channelId: channel.id,
  connectionId: connection.id,
  idempotencyKey: "key-1",
  requestFingerprint: "sha256:fingerprint",
  correlationId: "correlation-1",
  status: "queued",
  attemptCount: 0,
  createdAt: new Date("2026-09-21T12:00:00.000Z"),
  updatedAt: new Date("2026-09-21T12:00:00.000Z"),
};

const createAttempts = (current = attempt): PublicationAttemptRepository => ({
  listLatestForVariants: async () => new Map(),
  createOrFindByIdempotency: vi.fn(),
  createOrFindManualPublication: vi.fn(),
  findForWorkspace: vi.fn(async () => current),
  markPublishing: vi.fn(async () => ({
    ...current,
    status: "publishing" as const,
    attemptCount: 1,
  })),
  recordPublished: vi.fn(async ({ externalId }) => ({
    ...current,
    status: "published" as const,
    externalId,
  })),
  recordFailure: vi.fn(async ({ status, reason }) => ({
    ...current,
    status,
    terminalReason: reason,
  })),
});

type TestDependencies = Omit<PublishContentDependencies, "publisher"> & {
  publisher: SocialPublisher;
};

const dependencies = (overrides: Partial<TestDependencies> = {}): TestDependencies => {
  const attempts = createAttempts();
  const catalog = {
    search: vi.fn(async () => []),
    readProductEvidence: vi.fn(async () => refreshedEvidence()),
    readBuyerVoice: vi.fn(),
  } as unknown as MarketplaceCatalog;
  return {
    attempts,
    content: {
      findVariantForWorkspace: vi.fn(async () => variant),
      findContentItemForWorkspace: vi.fn(async () => contentItem),
    },
    offers: {
      findForWorkspace: vi.fn(async () => offer),
      addSnapshot: vi.fn(async () => offer),
    },
    catalogForWorkspace: vi.fn(() => catalog),
    channels: { findForWorkspace: vi.fn(async () => channel) },
    connections: { findForWorkspace: vi.fn(async () => connection) },
    policies: {
      findForWorkspace: vi.fn(async () => ({ workspaceId, mode: "manual" as const, version: 1 })),
    },
    publisher: {
      publish: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
    },
    ...overrides,
  };
};

const job = {
  payload: { version: 1 as const, workspaceId, identifiers: { attemptId: attempt.attemptId } },
};

describe("publish_content handler", () => {
  it("uses an identifier-only versioned job payload", () => {
    const payload = createPublishContentJobPayload({
      workspaceId,
      attemptId: "22222222-2222-4222-8222-222222222222",
    });
    expect(JSON.stringify(payload)).not.toContain("caption");
    expect(payload).toEqual({
      version: 1,
      workspaceId,
      identifiers: { attemptId: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("publishes only after revalidating approved content and active policy", async () => {
    const input = dependencies();
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "published", externalId: "post-1" });
    expect(input.publisher.publish).toHaveBeenCalledWith({
      secretReference: connection.secretReference,
      accountId: connection.accountId,
      platform: "threads",
      text: variant.caption,
      idempotencyKey: attempt.attemptId,
      accountHandle: connection.displayName,
      placement: "timeline",
    });
    expect(input.attempts.recordPublished).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      externalId: "post-1",
    });
  });

  it("uses one publication-scoped redirect across retries and carries the existing label", async () => {
    const records = new Map<string, ReturnType<typeof createRedirect>>();
    const variantLink = createRedirect({
      workspaceId,
      destination: new URL(offer.affiliateUrl ?? "https://meli.la/a"),
      expiresAt: new Date(Date.now() + TRACKED_LINK_TTL_MS),
      contentVariantId: variant.id,
      marketplaceLabel: "threads_tech",
    });
    const attributionRepository = {
      findForVariant: vi.fn(async () => variantLink),
      findForPublicationAttempt: vi.fn(
        async ({ attemptId }: { attemptId: string }) => records.get(attemptId) ?? null,
      ),
      createRedirect: vi.fn(async (record: ReturnType<typeof createRedirect>) => {
        records.set(record.publicationAttemptId ?? "", record);
        return record;
      }),
    } as unknown as AttributionRepository;
    const input = dependencies({
      content: {
        findVariantForWorkspace: vi.fn(async () => ({ ...variant, caption: "Buy {link}" })),
        findContentItemForWorkspace: vi.fn(async () => contentItem),
      },
      attributionRepository,
      publicApiUrl: "https://api.example.test",
    });
    const handler = createPublishContentHandler(input);

    await handler(job);
    await handler(job);
    await handler({
      payload: {
        version: 1,
        workspaceId,
        identifiers: { attemptId: "attempt-2" },
      },
    });

    expect(attributionRepository.createRedirect).toHaveBeenCalledTimes(2);
    const record = records.get(attempt.attemptId);
    expect(record).toMatchObject({
      workspaceId,
      contentVariantId: variant.id,
      publicationAttemptId: attempt.attemptId,
      marketplaceLabel: "threads_tech",
    });
    const expectedText = `Buy ${trackedUrl("https://api.example.test", record?.slug ?? "")}`;
    expect(input.publisher.publish).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ text: expectedText }),
    );
    expect(input.publisher.publish).toHaveBeenCalledTimes(3);
    expect(input.publisher.publish).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: expectedText }),
    );
    const secondRecord = records.get("attempt-2");
    expect(secondRecord?.slug).not.toBe(record?.slug);
    expect(input.publisher.publish).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        text: `Buy ${trackedUrl("https://api.example.test", secondRecord?.slug ?? "")}`,
      }),
    );
  });

  it("retries tracking persistence failure without calling the publisher", async () => {
    const attributionRepository = {
      findForVariant: vi.fn(async () => null),
      findForPublicationAttempt: vi.fn(async () => null),
      createRedirect: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
    } as unknown as AttributionRepository;
    const input = dependencies({
      content: {
        findVariantForWorkspace: vi.fn(async () => ({ ...variant, caption: "Buy {link}" })),
        findContentItemForWorkspace: vi.fn(async () => contentItem),
      },
      attributionRepository,
      publicApiUrl: "https://api.example.test",
    });

    await expect(createPublishContentHandler(input)(job)).resolves.toEqual({
      action: "retryable_failure",
      reason: "click_tracking_unavailable",
    });
    expect(input.publisher.publish).not.toHaveBeenCalled();
  });

  it("rejects a changed publication fingerprint before the publisher is called", async () => {
    const publisher = {
      publish: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
    };
    const input = dependencies({
      content: {
        findVariantForWorkspace: vi.fn(async () => ({
          ...variant,
          approval: { ...variant.approval!, publicationFingerprint: "a".repeat(64) },
        })),
        findContentItemForWorkspace: vi.fn(async () => contentItem),
      },
      assetRepository: { findForWorkspace: vi.fn(async () => null) } as never,
      publisher,
    });
    const result = await createPublishContentHandler(input)(job);
    expect(result).toEqual({ action: "permanent_failure", reason: "approval_stale" });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("blocks a refreshed closed listing permanently before publishing", async () => {
    const staleOffer = {
      ...offer,
      snapshots: [{ ...commercialSnapshot, verifiedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }],
    };
    const catalog = {
      readProductEvidence: vi.fn(async () => refreshedEvidence({ listingStatus: "closed" })),
    } as unknown as MarketplaceCatalog;
    const input = dependencies({
      offers: {
        findForWorkspace: vi.fn(async () => staleOffer),
        addSnapshot: vi.fn(async () => staleOffer),
      },
      catalogForWorkspace: vi.fn(() => catalog),
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "permanent_failure", reason: "listing_unavailable" });
    expect(input.publisher.publish).not.toHaveBeenCalled();
    expect(input.attempts.markPublishing).not.toHaveBeenCalled();
  });

  it("blocks a fresh snapshot already marked paused or closed", async () => {
    for (const listingStatus of ["paused", "closed"] as const) {
      const unavailableOffer: Offer = {
        ...offer,
        snapshots: [
          {
            ...commercialSnapshot,
            facts: [
              ...commercialSnapshot.facts.filter((fact) => fact.key !== "listing_status"),
              {
                key: "listing_status",
                value: listingStatus,
                sourceUrl,
                verified: true,
              },
            ],
          },
        ],
      };
      const catalogForWorkspace = vi.fn();
      const input = dependencies({
        offers: {
          findForWorkspace: vi.fn(async () => unavailableOffer),
          addSnapshot: vi.fn(async () => unavailableOffer),
        },
        catalogForWorkspace,
      });
      const result = await createPublishContentHandler(input)(job);

      expect(result).toEqual({ action: "permanent_failure", reason: "listing_unavailable" });
      expect(input.publisher.publish).not.toHaveBeenCalled();
      expect(catalogForWorkspace).not.toHaveBeenCalled();
    }
  });

  it("retries an unverifiable stale offer and fails permanently after the final attempt", async () => {
    const staleOffer = {
      ...offer,
      snapshots: [{ ...commercialSnapshot, verifiedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }],
    };
    const catalog = {
      readProductEvidence: vi.fn(async () => {
        throw new Error("timeout");
      }),
    } as unknown as MarketplaceCatalog;
    const input = dependencies({
      offers: {
        findForWorkspace: vi.fn(async () => staleOffer),
        addSnapshot: vi.fn(async () => staleOffer),
      },
      catalogForWorkspace: vi.fn(() => catalog),
    });

    const early = await createPublishContentHandler(input)({ ...job, attemptCount: 1 });
    expect(early).toEqual({ action: "retryable_failure", reason: "evidence_unverifiable" });
    const last = await createPublishContentHandler(input)({ ...job, attemptCount: 3 });
    expect(last).toEqual({ action: "permanent_failure", reason: "evidence_unverifiable" });
    expect(input.publisher.publish).not.toHaveBeenCalled();
  });

  it("stores the refreshed snapshot after a matching fresh read", async () => {
    const staleOffer = {
      ...offer,
      snapshots: [{ ...commercialSnapshot, verifiedAt: new Date(Date.now() - 7 * 60 * 60 * 1000) }],
    };
    const input = dependencies({
      offers: {
        findForWorkspace: vi.fn(async () => staleOffer),
        addSnapshot: vi.fn(async () => staleOffer),
      },
    });
    await createPublishContentHandler(input)(job);

    expect(input.offers.addSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, offerId: offer.id }),
    );
  });

  it("rejects instagram_stories: Stories are posted by hand, never by this worker", async () => {
    const storiesChannel: Channel = { ...channel, kind: "instagram_stories" };
    const input = dependencies({
      channels: { findForWorkspace: vi.fn(async () => storiesChannel) },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({
      action: "permanent_failure",
      reason: "manual_publication_required",
    });
    expect(input.publisher.publish).not.toHaveBeenCalled();
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "permanent_failure",
      reason: "manual_publication_required",
    });
  });

  it("gates a TikTok Shop draft on the Shop status instead of the Mercado Livre link", async () => {
    const shopOffer: Offer = {
      ...offer,
      marketplace: "tiktok_shop",
      affiliateUrl: "https://shop.tiktok.com/view/product/1",
    };
    const blocked = dependencies({
      channels: {
        findForWorkspace: vi.fn(
          async (): Promise<Channel> => ({ ...channel, kind: "tiktok_video" }),
        ),
      },
      offers: { ...dependencies().offers, findForWorkspace: vi.fn(async () => shopOffer) },
    });
    await expect(createPublishContentHandler(blocked)(job)).resolves.toEqual({
      action: "permanent_failure",
      reason: "shop_not_enabled",
    });
    expect(blocked.publisher.publish).not.toHaveBeenCalled();

    const enabled: Channel = {
      ...channel,
      kind: "tiktok_video",
      context: {
        tiktokShop: {
          version: 1,
          state: "shop_enabled",
          observedAt: new Date().toISOString(),
          source: "operator_confirmation",
        },
      },
    };
    const freshOffer: Offer = {
      ...shopOffer,
      snapshots: [{ ...commercialSnapshot, verifiedAt: new Date() }],
    };
    const allowed = dependencies({
      channels: { findForWorkspace: vi.fn(async () => enabled) },
      offers: { ...dependencies().offers, findForWorkspace: vi.fn(async () => freshOffer) },
    });
    await expect(createPublishContentHandler(allowed)(job)).resolves.toEqual({
      action: "published",
      externalId: "post-1",
    });
  });

  it("sends tiktok_video and tiktok_photo_post to the tiktok platform", async () => {
    for (const kind of ["tiktok_video", "tiktok_photo_post"] as const) {
      const tiktokChannel: Channel = { ...channel, kind };
      const input = dependencies({
        channels: { findForWorkspace: vi.fn(async () => tiktokChannel) },
      });
      const result = await createPublishContentHandler(input)(job);

      expect(result).toEqual({ action: "published", externalId: "post-1" });
      expect(input.publisher.publish).toHaveBeenCalledWith(
        expect.objectContaining({ platform: "tiktok" }),
      );
    }
  });

  it("publishes instagram_reels with reels placement, unlike stories it is not manual", async () => {
    const reelsChannel: Channel = { ...channel, kind: "instagram_reels" };
    const input = dependencies({
      channels: { findForWorkspace: vi.fn(async () => reelsChannel) },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "published", externalId: "post-1" });
    expect(input.publisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "instagram", placement: "reels" }),
    );
  });

  it("treats an accepted but still-processing publish as unknown and schedules reconciliation", async () => {
    const attemptId = "66666666-6666-4666-8666-666666666666";
    const uuidJob = { payload: { ...job.payload, identifiers: { attemptId } } };
    const enqueue = vi.fn(async (input: { name: string; idempotencyKey: string }) => ({
      id: "job-5",
      workspaceId,
      name: input.name,
      payload: uuidJob.payload,
      idempotencyKey: input.idempotencyKey,
      attemptCount: 0,
      maxAttempts: 8,
    }));
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => ({ externalId: "post-1", status: "queued" as const })),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
      jobs: { enqueue },
      attempts: createAttempts({ ...attempt, attemptId }),
    });
    const result = await createPublishContentHandler(input)(uuidJob);

    expect(result).toEqual({ action: "unknown_outcome", reason: "provider_still_processing" });
    expect(input.attempts.recordPublished).not.toHaveBeenCalled();
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId,
      status: "unknown_outcome",
      reason: "provider_still_processing",
    });
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "reconcile_publication",
      idempotencyKey: `reconcile:${attemptId}`,
    });
  });

  it("records a permanent failure when the provider reports the post failed", async () => {
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => ({
          externalId: "post-1",
          status: "failed" as const,
          failureReason: "Media rejected",
        })),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({
      action: "permanent_failure",
      reason: "provider_post_failed: Media rejected",
    });
    expect(input.attempts.recordPublished).not.toHaveBeenCalled();
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "permanent_failure",
      reason: "provider_post_failed: Media rejected",
    });
  });

  it("blocks a revoked connection without invoking the publisher", async () => {
    const input = dependencies({
      connections: {
        findForWorkspace: vi.fn(async () => ({ ...connection, status: "revoked" as const })),
      },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "permanent_failure", reason: "connection_unavailable" });
    expect(input.publisher.publish).not.toHaveBeenCalled();
  });

  it("treats an unresolved platform account as a permanent failure", async () => {
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("provider_account_not_found");
        }),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "permanent_failure", reason: "provider_account_not_found" });
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "permanent_failure",
      reason: "provider_account_not_found",
    });
  });

  it("keeps an unknown provider outcome out of automatic retry", async () => {
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("provider_timeout");
        }),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
    });
    const result = await createPublishContentHandler(input)(job);

    expect(result).toEqual({ action: "unknown_outcome", reason: "provider_timeout" });
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "unknown_outcome",
      reason: "provider_timeout",
    });
  });
  it("enqueues a reconcile job when the provider outcome is unknown", async () => {
    // Job payloads carry UUIDs only; production attempt ids come from randomUUID().
    const attemptId = "33333333-3333-4333-8333-333333333333";
    const uuidJob = { payload: { ...job.payload, identifiers: { attemptId } } };
    const enqueue = vi.fn(async (input: { name: string; idempotencyKey: string }) => ({
      id: "job-2",
      workspaceId,
      name: input.name,
      payload: job.payload,
      idempotencyKey: input.idempotencyKey,
      attemptCount: 0,
      maxAttempts: 8,
    }));
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("provider_timeout");
        }),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
      jobs: { enqueue },
      attempts: createAttempts({ ...attempt, attemptId }),
    });
    const result = await createPublishContentHandler(input)(uuidJob);
    expect(result.action).toBe("unknown_outcome");
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "reconcile_publication",
      idempotencyKey: `reconcile:${attemptId}`,
      payload: { workspaceId, identifiers: { attemptId } },
    });
  });

  it("does not enqueue reconciliation on success or permanent failure", async () => {
    const enqueue = vi.fn();
    await createPublishContentHandler(dependencies({ jobs: { enqueue } }))(job);
    await createPublishContentHandler(
      dependencies({
        publisher: {
          publish: vi.fn(async () => {
            throw new Error("provider_rejected");
          }),
          reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
        },
        jobs: { enqueue },
      }),
    )(job);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("records a permanent failure when the last publish attempt fails retryably", async () => {
    const input = dependencies({
      publisher: {
        publish: vi.fn(async () => {
          throw new Error("provider_rate_limited");
        }),
        reconcile: vi.fn(async () => ({ externalId: "post-1", status: "published" as const })),
      },
    });
    const early = await createPublishContentHandler(input)({ ...job, attemptCount: 1 });
    expect(early.action).toBe("retryable_failure");
    const last = await createPublishContentHandler(input)({ ...job, attemptCount: 3 });
    expect(last).toEqual({ action: "permanent_failure", reason: "provider_rate_limited" });
    expect(input.attempts.recordFailure).toHaveBeenLastCalledWith({
      workspaceId,
      attemptId: attempt.attemptId,
      status: "permanent_failure",
      reason: "provider_rate_limited",
    });
  });

  it("marks an interrupted publication unknown and schedules reconciliation", async () => {
    const attemptId = "44444444-4444-4444-8444-444444444444";
    const enqueue = vi.fn(async (input: { name: string; idempotencyKey: string }) => ({
      id: "job-3",
      workspaceId,
      name: input.name,
      payload: job.payload,
      idempotencyKey: input.idempotencyKey,
      attemptCount: 0,
      maxAttempts: 8,
    }));
    const input = dependencies({
      attempts: createAttempts({ ...attempt, attemptId, status: "publishing" }),
      jobs: { enqueue },
    });
    const result = await createPublishContentHandler(input)({
      payload: { ...job.payload, identifiers: { attemptId } },
    });
    expect(result).toEqual({ action: "unknown_outcome", reason: "publication_interrupted" });
    expect(input.publisher.publish).not.toHaveBeenCalled();
    expect(input.attempts.recordFailure).toHaveBeenCalledWith({
      workspaceId,
      attemptId,
      status: "unknown_outcome",
      reason: "publication_interrupted",
    });
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      name: "reconcile_publication",
      idempotencyKey: `reconcile:${attemptId}`,
    });
  });
  it("re-schedules reconciliation when a retried job finds an unknown outcome", async () => {
    const attemptId = "55555555-5555-4555-8555-555555555555";
    const enqueue = vi.fn(async (input: { name: string; idempotencyKey: string }) => ({
      id: "job-4",
      workspaceId,
      name: input.name,
      payload: job.payload,
      idempotencyKey: input.idempotencyKey,
      attemptCount: 0,
      maxAttempts: 8,
    }));
    const input = dependencies({
      attempts: createAttempts({ ...attempt, attemptId, status: "unknown_outcome" }),
      jobs: { enqueue },
    });
    const result = await createPublishContentHandler(input)({
      payload: { ...job.payload, identifiers: { attemptId } },
    });
    expect(result.action).toBe("unknown_outcome");
    expect(input.publisher.publish).not.toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: `reconcile:${attemptId}` });
  });
});
