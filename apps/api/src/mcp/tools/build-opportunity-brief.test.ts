import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { buildOpportunityBriefTool } from "./build-opportunity-brief.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre" as const,
  listingUrl: "https://www.mercadolivre.com.br/p/MLB123",
  affiliateUrl: "https://meli.la/abc",
  title: "Organizador compacto",
  state: "active" as const,
  snapshots: [],
};

const deps = (
  member = true,
  readBuyerVoice = async () => ({
    providerId: "MLB123",
    sourceUrl: new URL(offer.listingUrl),
    observedAt: new Date("2026-10-01T12:00:00Z"),
    ratingAverage: null,
    reviewCount: 0,
    positiveReviews: [],
    negativeReviews: [],
    questions: [],
    pictures: [],
    unavailable: [],
  }),
) =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () =>
        member ? { workspaceId, userId: actorId, role: "owner", status: "active" } : null,
    },
    offerRepository: { findForWorkspace: vi.fn(async () => offer) },
    marketplaceCatalogForWorkspace: () => ({
      search: async () => [],
      readProductEvidence: async () => {
        throw new Error("not_used");
      },
      readBuyerVoice,
    }),
  }) as unknown as McpDependencies;

describe("build_opportunity_brief MCP tool", () => {
  it("assembles source-linked offer and buyer evidence without claiming sales", async () => {
    const result = await buildOpportunityBriefTool(
      { workspaceId, offerId: "offer-1" },
      actorId,
      deps(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        offer: { id: "offer-1", affiliateLinkAvailable: true },
        signals: {
          price: { status: "unknown" },
          buyerVoice: { status: "observed", sourceUrl: offer.listingUrl },
          competition: { status: "missing" },
          salesAndProfit: { status: "not_measured" },
        },
        readiness: "incomplete",
      },
    });
  });

  it("keeps a buyer-voice provider outage visible in the partial brief", async () => {
    const result = await buildOpportunityBriefTool(
      { workspaceId, offerId: "offer-1" },
      actorId,
      deps(true, async () => {
        throw new Error("mercado_livre_not_connected");
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        signals: { buyerVoice: { status: "missing", unavailableReason: "provider_unavailable" } },
      },
    });
  });

  it("enforces workspace access and reports missing offers", async () => {
    await expect(
      buildOpportunityBriefTool({ workspaceId, offerId: "offer-1" }, actorId, deps(false)),
    ).resolves.toMatchObject({ ok: false, error: "FORBIDDEN" });
    const missing = deps();
    (
      missing.offerRepository as unknown as { findForWorkspace: () => Promise<null> }
    ).findForWorkspace = async () => null;
    await expect(
      buildOpportunityBriefTool({ workspaceId, offerId: "missing" }, actorId, missing),
    ).resolves.toMatchObject({ ok: false, error: "NOT_FOUND" });
  });
});
