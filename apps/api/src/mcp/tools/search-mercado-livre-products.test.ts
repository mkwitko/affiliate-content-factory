import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { searchMercadoLivreProductsTool } from "./search-mercado-livre-products.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
};

describe("search_mercado_livre_products MCP tool", () => {
  it("returns a clear tool error when the workspace has no Mercado Livre connection", async () => {
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      marketplaceCatalogForWorkspace: () => ({
        search: async () => {
          throw new Error("mercado_livre_not_connected");
        },
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("mercado_livre_not_connected");
        },
      }),
    };

    const result = await searchMercadoLivreProductsTool(
      { workspaceId, query: "cafeteira", limit: 5 },
      actorId,
      dependencies,
    );

    expect(result).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });

  it("searches using the workspace-scoped catalog when connected", async () => {
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [
          {
            providerId: "MLB1",
            title: "Produto",
            listingUrl: new URL("https://mercadolivre.com.br/p/MLB1"),
            seller: "Loja",
            availability: "available",
            listingStatus: "active",
            currentPrice: { amountMinor: 1000, currency: "BRL" },
          },
        ],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("not_used");
        },
      }),
    };

    const result = await searchMercadoLivreProductsTool(
      { workspaceId, query: "cafeteira", limit: 5 },
      actorId,
      dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        products: [{ providerId: "MLB1", lastPostedAt: null, postedCount: 0, inCooldown: false }],
        affiliateLinkBuilderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
      },
    });
  });

  it("annotates a product still in cooldown when a nicheId is given", async () => {
    // Relative to now: a fixed date expires once the 21-day cooldown passes (it did on 2026-10-01).
    const lastPublishedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [
          {
            providerId: "MLB1",
            title: "Produto",
            listingUrl: new URL("https://mercadolivre.com.br/p/MLB1"),
            seller: "Loja",
            availability: "available",
            listingStatus: "active",
            currentPrice: { amountMinor: 1000, currency: "BRL" },
          },
        ],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("not_used");
        },
      }),
      productPostingHistoryRepository: {
        productPostingHistory: async () => [
          {
            productId: "MLB1",
            offerTitle: "Produto",
            lastPublishedAt,
            publishedCount: 1,
            channels: ["instagram_carousel"],
          },
        ],
      },
    };

    const result = await searchMercadoLivreProductsTool(
      { workspaceId, query: "cafeteira", limit: 5, nicheId: "niche-1" },
      actorId,
      dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        products: [
          {
            providerId: "MLB1",
            lastPostedAt: lastPublishedAt.toISOString(),
            postedCount: 1,
            inCooldown: true,
          },
        ],
      },
    });
  });
});
