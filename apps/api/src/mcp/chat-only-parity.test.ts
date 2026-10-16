import { describe, expect, it } from "vitest";
import {
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId,
} from "@money-maker/contracts";
import { addEvidenceSnapshot, activateOffer, type Offer } from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ContentItem } from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type {
  PublicationAttempt,
  PublicationAttemptRepository,
} from "@money-maker/core/publishing/publication";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import { createMcpServer, type McpDependencies } from "./server.js";
import { oauthScopes } from "../auth/oidc-token-verifier.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const call = async (server: ReturnType<typeof createMcpServer>, name: string, args: unknown) =>
  server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

const fixture = (role: WorkspaceMembership["role"] = "owner"): McpDependencies => {
  let niche: Niche | undefined;
  let offer: Offer | undefined;
  let item: ContentItem | undefined;
  const membership = (target: WorkspaceId, actor: UserId): WorkspaceMembership | null =>
    target === workspaceId && actor === userId
      ? { userId: actor, workspaceId: target, role, status: "active" }
      : null;
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async ({ workspaceId: target, userId: actor }) =>
      membership(target, actor) ? { id: target, name: "Workspace" } : null,
    findMembership: async ({ workspaceId: target, userId: actor }) => membership(target, actor),
    addMembership: async () => undefined,
  };
  const invitation = {
    memberships: {
      findByUserAndWorkspace: async ({ workspaceId: target, userId: actor }) =>
        membership(target, actor),
      ensureMembership: async () => "created",
    },
    invitations: {} as InvitationDependencies["invitations"],
    audit: { record: async () => "audit" },
    clock: { now: () => new Date() },
    tokens: { generate: () => "token" },
    tokenHasher: { hash: async () => "hash" },
  } as InvitationDependencies;
  const niches: NicheRepository = {
    create: async (value) => (niche = value),
    listForWorkspace: async (target) => (niche && niche.workspaceId === target ? [niche] : []),
    findForWorkspace: async ({ workspaceId: target }) =>
      niche?.workspaceId === target ? niche : null,
    updateState: async () => niche ?? null,
  };
  const offers: OfferRepository = {
    create: async (value) => (offer = value),
    listForWorkspace: async (target) => (offer?.workspaceId === target ? [offer] : []),
    findForWorkspace: async ({ workspaceId: target }) =>
      offer?.workspaceId === target ? offer : null,
    addSnapshot: async ({ workspaceId: target, snapshot }) => {
      if (!offer || offer.workspaceId !== target) return null;
      offer = addEvidenceSnapshot(offer, snapshot);
      return offer;
    },
    activate: async ({ workspaceId: target }) => {
      if (!offer || offer.workspaceId !== target) return null;
      offer = activateOffer(offer);
      return offer;
    },
    reject: async () => offer ?? null,
  };
  const content: ContentRepository = {
    listContentItemsWithoutActiveVariants: async () => [],
    updateContentItemState: async () => null,
    createContentItem: async (value) => (item = value),
    listContentItemsForWorkspace: async () => (item ? [item] : []),
    findContentItemForWorkspace: async ({ workspaceId: target }) =>
      item?.workspaceId === target ? item : null,
    createVariant: async (value) => value,
    listVariantsForWorkspace: async () => [],
    findVariantForWorkspace: async () => null,
    findReviewableForWorkspace: async () => [],
    updateVariant: async (value) => value,
    updateContentItem: async (item) => item,
    recordApproval: async ({ variant }) => variant,
  };
  const publication: PublicationAttempt = {
    attemptId: "attempt-1",
    workspaceId,
    contentVariantId: "variant-1",
    channelId: "channel-1",
    connectionId: "connection-1",
    idempotencyKey: "key",
    requestFingerprint: "fingerprint",
    correlationId: "correlation",
    status: "queued",
    attemptCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const publications: PublicationAttemptRepository = {
    listLatestForVariants: async () => new Map(),
    createOrFindByIdempotency: async () => ({ created: false, attempt: publication }),
    createOrFindManualPublication: async () => ({ created: false, attempt: publication }),
    findForWorkspace: async ({ workspaceId: target }) =>
      target === workspaceId ? publication : null,
    markPublishing: async () => publication,
    recordPublished: async () => publication,
    recordFailure: async () => publication,
  };
  return {
    authenticate: async () => ({
      userId,
      verifiedEmail: "owner@example.com",
      scopes: new Set(oauthScopes),
    }),
    invitation,
    workspaces,
    nicheRepository: niches,
    offerRepository: offers,
    audit: { record: async () => "audit" },
    contentRepository: content,
    publicationAttempts: publications,
  };
};

describe("MCP chat-only operator parity", () => {
  it("runs niche, evidenced offer, content item, and publication status journey", async () => {
    const server = createMcpServer(fixture());
    const nicheResponse = await call(server, "create_niche", {
      workspaceId,
      name: "Casa",
      audience: "Famílias",
      problem: "Organizar a casa",
      editorialVoice: "Prático",
      languages: ["pt-BR"],
      monetizationHypothesis: "Afiliados",
    });
    const nichePayload = nicheResponse.result?.structuredContent;
    expect(nichePayload).toMatchObject({ niche: { id: expect.any(String) } });
    const nicheId = (nichePayload as { niche: Niche }).niche.id;
    const offerResponse = await call(server, "create_offer", {
      workspaceId,
      listingUrl: "https://mercadolivre.example/item/1",
      affiliateUrl: "https://affiliate.example/item/1",
      title: "Produto",
      currentPrice: { amountMinor: 1000, currency: "BRL" },
    });
    const offerPayload = offerResponse.result?.structuredContent;
    expect(offerPayload).toMatchObject({ offer: { id: expect.any(String) } });
    const offerId = (offerPayload as { offer: Offer }).offer.id;
    await call(server, "add_offer_evidence", {
      workspaceId,
      offerId,
      snapshot: {
        id: "snapshot-1",
        verifiedAt: new Date().toISOString(),
        facts: [
          {
            key: "seller",
            value: "Loja",
            sourceUrl: "https://mercadolivre.example/item/1",
            verified: true,
          },
          {
            key: "availability",
            value: true,
            sourceUrl: "https://mercadolivre.example/item/1",
            verified: true,
          },
          {
            key: "current_price",
            value: { amountMinor: 1000, currency: "BRL" },
            sourceUrl: "https://mercadolivre.example/item/1",
            verified: true,
          },
        ],
      },
    });
    await call(server, "activate_offer", { workspaceId, offerId });
    const contentResponse = await call(server, "create_content_item", {
      workspaceId,
      nicheId,
      offerId,
      title: "Post",
      sourceFactKeys: ["current_price"],
      creativeOpinion: "Mostre o benefício",
    });
    expect(contentResponse.result?.structuredContent).toMatchObject({
      contentItem: { workspaceId, state: "draft" },
    });
    const status = await call(server, "get_publication_status", {
      workspaceId,
      attemptId: "attempt-1",
    });
    expect(status.result?.structuredContent).toMatchObject({
      publication: { attemptId: "attempt-1", status: "queued" },
    });
  });

  it("denies mutations for reviewer and denies another workspace", async () => {
    const reviewer = await call(createMcpServer(fixture("reviewer")), "create_niche", {
      workspaceId,
      name: "Casa",
      audience: "Famílias",
      problem: "Organizar",
      editorialVoice: "Prático",
      languages: ["pt-BR"],
      monetizationHypothesis: "Afiliados",
    });
    expect(reviewer.result?.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
    const other = await call(createMcpServer(fixture()), "list_niches", {
      workspaceId: otherWorkspaceId,
    });
    expect(other.result?.structuredContent).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
