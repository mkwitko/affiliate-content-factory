import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { createOffer } from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const createFixture = () => {
  const offers = new Map<string, ReturnType<typeof createOffer>>();
  const auditEvents: Array<Record<string, unknown>> = [];
  const repository: OfferRepository = {
    create: async (offer) => {
      offers.set(offer.id, offer);
      return offer;
    },
    findForWorkspace: async ({ workspaceId: targetWorkspaceId, offerId }) =>
      targetWorkspaceId === workspaceId ? (offers.get(offerId) ?? null) : null,
    addSnapshot: async () => null,
    activate: async () => null,
    reject: async () => null,
  };
  const dependencies = {
    invitation: {} as InvitationDependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async ({
        workspaceId: targetWorkspaceId,
      }: {
        workspaceId: typeof workspaceId;
      }) => (targetWorkspaceId === workspaceId ? { id: workspaceId, name: "Workspace" } : null),
      findMembership: async ({
        workspaceId: targetWorkspaceId,
        userId: targetUserId,
      }: {
        workspaceId: typeof workspaceId;
        userId: typeof userId;
      }) =>
        targetWorkspaceId === workspaceId
          ? { workspaceId, userId: targetUserId, role: "operator", status: "active" }
          : null,
      addMembership: async () => undefined,
    },
    offerRepository: repository,
    audit: {
      record: async (event: Record<string, unknown>) => {
        auditEvents.push(event);
        return "audit-1";
      },
    },
    authenticate: async () => ({ userId, verifiedEmail: "operator@example.com" }),
  } as unknown as ApiDependencies;
  return { dependencies, auditEvents };
};

describe("offer routes", () => {
  it("rejects decimal money input at the HTTP boundary", async () => {
    const app = buildApp(createFixture().dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/offers`,
      payload: {
        listingUrl: "https://mercadolivre.example/item/1",
        affiliateUrl: "https://affiliate.example/item/1",
        title: "Example product",
        currentPrice: { amountMinor: 129.9, currency: "BRL" },
      },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("creates a redacted offer and records an audit event", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/offers`,
      payload: {
        listingUrl: "https://mercadolivre.example/item/1",
        affiliateUrl: "https://affiliate.example/item/1",
        title: "Example product",
        currentPrice: { amountMinor: 12990, currency: "BRL" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().offer).toMatchObject({
      workspaceId,
      affiliateUrl: "https://affiliate.example/item/1",
      state: "draft",
    });
    expect(fixture.auditEvents).toContainEqual(
      expect.objectContaining({ action: "offer.created", workspaceId, actorUserId: userId }),
    );
    await app.close();
  });
});
