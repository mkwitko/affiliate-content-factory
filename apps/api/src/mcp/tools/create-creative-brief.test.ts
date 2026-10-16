import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { createCreativeBriefTool } from "./create-creative-brief.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const deps = (member = true) =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () =>
        member ? { workspaceId, userId: actorId, role: "owner", status: "active" } : null,
    },
    offerRepository: {
      findForWorkspace: async () => ({
        id: "offer-1",
        workspaceId,
        marketplace: "mercado_livre",
        listingUrl: "https://www.mercadolivre.com.br/p/MLB123",
        affiliateUrl: "https://meli.la/abc",
        title: "Organizador compacto",
        state: "active",
        snapshots: [],
      }),
    },
    marketplaceCatalogForWorkspace: () => ({
      search: async () => [],
      readProductEvidence: async () => {
        throw new Error("not_used");
      },
      readBuyerVoice: async () => ({
        providerId: "MLB123",
        sourceUrl: new URL("https://www.mercadolivre.com.br/p/MLB123"),
        observedAt: new Date("2026-10-01T12:00:00Z"),
        ratingAverage: null,
        reviewCount: 1,
        positiveReviews: [],
        negativeReviews: [{ rating: 1, title: "Ruim", text: "Não encaixa" }],
        questions: [],
        pictures: [],
        unavailable: [],
      }),
    }),
    channelRepository: {
      findForWorkspace: async () => ({
        id: "channel-1",
        workspaceId,
        connectionId: "connection-1",
        kind: "instagram_carousel",
        label: "Instagram",
        status: "active",
        capabilities: { maxAssets: 10, requiresOrderedAssets: true, allowedMimeTypes: [] },
      }),
    },
  }) as unknown as McpDependencies;

describe("create_creative_brief MCP tool", () => {
  it("returns a channel-specific, reviewable direction tied to actual buyer evidence", async () => {
    const result = await createCreativeBriefTool(
      { workspaceId, offerId: "offer-1", channelId: "channel-1", audience: "renters" },
      actorId,
      deps(),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        format: "instagram_carousel",
        angle: "buyer_pain",
        hook: {
          evidence: {
            excerpt: "Ruim — Não encaixa",
            sourceUrl: "https://www.mercadolivre.com.br/p/MLB123",
          },
        },
        claims: [],
        opportunityReadiness: "incomplete",
        requiresHumanReview: true,
      },
    });
  });

  it("denies nonmembers and rejects invalid audience input", async () => {
    await expect(
      createCreativeBriefTool(
        { workspaceId, offerId: "offer-1", channelId: "channel-1", audience: "renters" },
        actorId,
        deps(false),
      ),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
    await expect(
      createCreativeBriefTool(
        { workspaceId, offerId: "offer-1", channelId: "channel-1", audience: " " },
        actorId,
        deps(),
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
