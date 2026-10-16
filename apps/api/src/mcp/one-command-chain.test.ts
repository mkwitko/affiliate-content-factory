import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { EnqueueJobInput, QueuedJob } from "@money-maker/core/jobs/job";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { McpDependencies } from "./server.js";
import { approveContentTool } from "./tools/approve-content.js";
import { createContentVariantTool } from "./tools/create-content-variant.js";
import { getPublicationStatusTool } from "./tools/get-publication-status.js";
import { listPendingContentTool } from "./tools/list-pending-content.js";
import { publishContentTool } from "./tools/publish-content.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
  affiliateUrl: "https://meli.la/abc",
  title: "Suporte de notebook",
  state: "active",
  activeSnapshotId: "snapshot-1",
  snapshots: [
    {
      id: "snapshot-1",
      verifiedAt: new Date("2026-09-23T10:00:00Z"),
      facts: [
        {
          key: "current_price",
          value: "R$ 22,90",
          sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
          verified: true,
        },
      ],
    },
  ],
};
const connection: ProviderConnection = {
  id: "conn-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  accountId: "account-1",
  secretReference: "secret://workspace/pfm",
  status: "active",
};
const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: connection.id,
  kind: "instagram_carousel",
  label: "Feed",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg", "image/png"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1350 },
  },
};
const item: ContentItem = {
  id: "content-1",
  workspaceId,
  nicheId: "niche-1",
  offerId: offer.id,
  offerSnapshotId: "snapshot-1",
  title: "Post",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "x",
  state: "draft",
};
const asset: Asset = {
  id: "asset-1",
  workspaceId,
  objectKey: "k",
  checksum: "sha256:1",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1350,
  provenance: "provider_import",
  commercialUse: null,
  license: "Canva design export",
  state: "active",
};

const build = () => {
  const variants = new Map<string, ContentVariant>();
  const attempts = new Map<string, PublicationAttempt>();
  const jobs: EnqueueJobInput[] = [];
  const publicationAttempts: PublicationAttemptRepository = {
    createOrFindByIdempotency: async (input) => {
      const attempt: PublicationAttempt = {
        ...input,
        status: "queued",
        attemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      attempts.set(input.attemptId, attempt);
      return { created: true, attempt };
    },
    createOrFindManualPublication: async () => {
      throw new Error("not_used");
    },
    findForWorkspace: async ({ attemptId }) => attempts.get(attemptId) ?? null,
    listLatestForVariants: async ({ variantIds }) =>
      new Map(
        [...attempts.values()]
          .filter((attempt) => variantIds.includes(attempt.contentVariantId))
          .map((attempt) => [attempt.contentVariantId, attempt] as const),
      ),
    markPublishing: async () => null,
    recordPublished: async () => {
      throw new Error("not_used");
    },
    recordFailure: async () => {
      throw new Error("not_used");
    },
  };
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
      addMembership: async () => undefined,
    },
    contentRepository: {
      listContentItemsWithoutActiveVariants: async () => [],
      updateContentItemState: async () => null,
      createContentItem: async (value) => value,
      findContentItemForWorkspace: async () => item,
      createVariant: async (value) => {
        variants.set(value.id, value);
        return value;
      },
      listVariantsForWorkspace: async () => [...variants.values()],
      findVariantForWorkspace: async ({ variantId }) => variants.get(variantId) ?? null,
      findReviewableForWorkspace: async () => [],
      updateVariant: async (value) => {
        variants.set(value.id, value);
        return value;
      },
      updateContentItem: async (item) => item,
      recordApproval: async ({ variant, decision }) => {
        const approved: ContentVariant = { ...variant, state: "approved", approval: decision };
        variants.set(variant.id, approved);
        return approved;
      },
    },
    channelRepository: {
      create: async (value) => value,
      findForWorkspace: async () => channel,
      listForWorkspace: async () => [channel],
      updateStatus: async () => null,
    },
    offerRepository: {
      create: async (value) => value,
      findForWorkspace: async () => offer,
      addSnapshot: async () => null,
      activate: async () => null,
      reject: async () => null,
    },
    providerConnections: {
      create: async (value) => ({ ok: true as const, connection: value }),
      findAllForWorkspace: async () => [connection],
      findForWorkspace: async () => connection,
      revoke: async () => undefined,
    },
    assetRepository: {
      create: async (value) => value,
      findByMetadata: async () => null,
      findForWorkspace: async () => asset,
      updateState: async () => null,
      completeRenderedAsset: async () => null,
    },
    publicationPolicyRepository: {
      findForWorkspace: async () => ({ workspaceId, mode: "manual", version: 1 }),
      create: async (value) => value,
      update: async (value) => value,
    },
    publicationAttempts,
    jobQueue: {
      enqueue: async (input) => {
        jobs.push(input);
        return {
          id: "job-1",
          workspaceId,
          name: input.name,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
          attemptCount: 0,
          maxAttempts: 3,
        } as QueuedJob;
      },
      claim: async () => null,
      complete: async () => undefined,
      retry: async () => undefined,
      failPermanently: async () => undefined,
    },
    audit: { record: async () => "audit-1" },
  };
  return { dependencies, jobs };
};

describe("one-command chain: variant, approve, publish, status", () => {
  it("publishes a Canva-backed draft after one approval and lists it as waiting", async () => {
    const { dependencies, jobs } = build();
    const created = await createContentVariantTool(
      {
        workspaceId,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: "snapshot-1",
        assetIds: [asset.id],
        caption: "#publi Não é a cadeira. É a altura da tela.",
        language: "pt-BR",
        design: { canvaDesignId: "DAF1", pages: [1], width: 1080, height: 1350 },
      },
      actorId,
      dependencies,
    );
    if (!created.ok) throw new Error(`create failed: ${created.error}`);
    const variantId = (created.value as { variant: ContentVariant }).variant.id;

    const pendingBefore = await listPendingContentTool({ workspaceId }, actorId, dependencies);
    expect(pendingBefore).toMatchObject({
      ok: true,
      value: {
        items: [
          { variantId, nextAction: "approve", editUrl: "https://www.canva.com/design/DAF1/edit" },
        ],
      },
    });

    const approved = await approveContentTool({ workspaceId, variantId }, actorId, dependencies);
    if (!approved.ok) throw new Error(`approve failed: ${approved.error}`);
    expect((approved.value as { variant: ContentVariant }).variant.state).toBe("approved");

    const published = await publishContentTool(
      { workspaceId, contentVariantId: variantId, idempotencyKey: `publish:${variantId}` },
      actorId,
      dependencies,
    );
    if (!published.ok) throw new Error(`publish failed: ${published.error}`);
    const { attemptId } = (published.value as { publication: PublicationAttempt }).publication;
    expect(jobs.map((job) => job.name)).toEqual(["publish_content"]);

    const status = await getPublicationStatusTool(
      { workspaceId, attemptId },
      actorId,
      dependencies,
    );
    expect(status).toMatchObject({ ok: true, value: { publication: { status: "queued" } } });

    const pendingAfter = await listPendingContentTool({ workspaceId }, actorId, dependencies);
    expect(pendingAfter).toMatchObject({
      ok: true,
      value: { items: [{ variantId, nextAction: "wait", attempt: { status: "queued" } }] },
    });
  });
});
