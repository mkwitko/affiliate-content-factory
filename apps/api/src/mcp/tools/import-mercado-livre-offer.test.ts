import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { importMercadoLivreOfferTool } from "./import-mercado-livre-offer.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
};

const base = (): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces,
  offerRepository: {
    create: async (value: unknown) => value,
    findForWorkspace: async () => null,
    listForWorkspace: async () => [],
    updateState: async () => null,
    addEvidence: async () => null,
  } as unknown as NonNullable<McpDependencies["offerRepository"]>,
  audit: { record: async () => "audit" },
  marketplaceCatalogForWorkspace: () => ({
    search: async () => [],
    readBuyerVoice: async () => {
      throw new Error("not_used");
    },
    readProductEvidence: async () => {
      throw new Error("mercado_livre_not_connected");
    },
  }),
});

describe("import_mercado_livre_offer MCP tool", () => {
  it("rejects an affiliate link outside Mercado Livre", async () => {
    const result = await importMercadoLivreOfferTool(
      { workspaceId, productId: "MLB1", affiliateUrl: "https://example.com/aff" },
      actorId,
      base(),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("resolves the product from the affiliate link when productId is absent", async () => {
    const seen: string[] = [];
    const dependencies: McpDependencies = {
      ...base(),
      affiliateLinkResolver: async () => ({
        productId: "MLB777",
        finalUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
      }),
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async (productId: string) => {
          seen.push(productId);
          throw new Error("mercado_livre_not_connected");
        },
      }),
    };
    await importMercadoLivreOfferTool(
      { workspaceId, affiliateUrl: "https://meli.la/abc" },
      actorId,
      dependencies,
    );
    expect(seen).toEqual(["MLB777"]);
  });

  it("returns the resolved productId so the caller can read buyer voice next", async () => {
    const stored: unknown[] = [];
    const dependencies: McpDependencies = {
      ...base(),
      affiliateLinkResolver: async () => ({
        productId: "MLB777",
        finalUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
      }),
      offerRepository: {
        create: async (value: unknown) => {
          stored.push(value);
          return value;
        },
        findForWorkspace: async () => stored[0] ?? null,
        addSnapshot: async () => stored[0] ?? null,
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => ({
          providerId: "MLB777",
          title: "Suporte de notebook",
          listingUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
          seller: "Loja",
          availability: "available",
          listingStatus: "active",
          currentPrice: { amountMinor: 2290, currency: "BRL" },
          observedAt: new Date("2026-09-23T10:00:00Z"),
        }),
      }),
    };
    const result = await importMercadoLivreOfferTool(
      { workspaceId, affiliateUrl: "https://meli.la/abc" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({ ok: true, value: { productId: "MLB777" } });
  });

  it("stores every commercial fact Mercado Livre returned, with the discount derived from list and current price", async () => {
    const snapshots: { facts: { key: string; value: unknown }[] }[] = [];
    const created: unknown[] = [];
    const listingUrl = "https://www.mercadolivre.com.br/x/p/MLB777";
    const dependencies: McpDependencies = {
      ...base(),
      offerRepository: {
        create: async (value: unknown) => {
          created.push(value);
          return value;
        },
        findForWorkspace: async () => created[0] ?? null,
        addSnapshot: async (input: { snapshot: { facts: { key: string; value: unknown }[] } }) => {
          snapshots.push(input.snapshot);
          return null;
        },
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => ({
          providerId: "MLB777",
          title: "Suporte de notebook",
          listingUrl: new URL(listingUrl),
          seller: "Loja",
          availability: "available",
          listingStatus: "active",
          currentPrice: { amountMinor: 3790, currency: "BRL" },
          listPrice: { amountMinor: 5490, currency: "BRL" },
          soldQuantity: 12000,
          availableQuantity: 7,
          freeShipping: true,
          ratingAverage: 4.8,
          reviewCount: 9231,
          observedAt: new Date("2026-09-23T10:00:00Z"),
        }),
      }),
    };
    await importMercadoLivreOfferTool(
      { workspaceId, productId: "MLB777", affiliateUrl: "https://meli.la/abc" },
      actorId,
      dependencies,
    );
    const stored = snapshots[0]?.facts ?? [];
    const facts = Object.fromEntries(stored.map((fact) => [fact.key, fact.value]));
    expect(facts).toEqual({
      seller: "Loja",
      availability: "available",
      listing_status: "active",
      current_price: { amountMinor: 3790, currency: "BRL" },
      list_price: { amountMinor: 5490, currency: "BRL" },
      discount_percent: 30,
      sold_quantity: 12000,
      available_quantity: 7,
      free_shipping: true,
      rating_average: 4.8,
      review_count: 9231,
    });
    expect(stored.every((fact) => (fact as { sourceUrl?: string }).sourceUrl === listingUrl)).toBe(
      true,
    );
  });

  it("warns recently_posted when the product is in cooldown for the given niche, but still imports it", async () => {
    const lastPublishedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const stored: unknown[] = [];
    const dependencies: McpDependencies = {
      ...base(),
      offerRepository: {
        create: async (value: unknown) => {
          stored.push(value);
          return value;
        },
        findForWorkspace: async () => stored[0] ?? null,
        addSnapshot: async () => stored[0] ?? null,
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      productPostingHistoryRepository: {
        productPostingHistory: async () => [
          {
            productId: "MLB777",
            offerTitle: "Suporte de notebook",
            lastPublishedAt,
            publishedCount: 1,
            channels: ["instagram_carousel"],
          },
        ],
      },
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => ({
          providerId: "MLB777",
          title: "Suporte de notebook",
          listingUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
          seller: "Loja",
          availability: "available",
          listingStatus: "active",
          currentPrice: { amountMinor: 2290, currency: "BRL" },
          observedAt: new Date("2026-09-23T10:00:00Z"),
        }),
      }),
    };
    const result = await importMercadoLivreOfferTool(
      { workspaceId, productId: "MLB777", affiliateUrl: "https://meli.la/abc", nicheId: "niche-1" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        productId: "MLB777",
        warning: { code: "recently_posted", lastPostedAt: lastPublishedAt.toISOString() },
      },
    });
  });

  it("imports without a warning once the cooldown has elapsed", async () => {
    const lastPublishedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const stored: unknown[] = [];
    const dependencies: McpDependencies = {
      ...base(),
      offerRepository: {
        create: async (value: unknown) => {
          stored.push(value);
          return value;
        },
        findForWorkspace: async () => stored[0] ?? null,
        addSnapshot: async () => stored[0] ?? null,
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      productPostingHistoryRepository: {
        productPostingHistory: async () => [
          {
            productId: "MLB777",
            offerTitle: "Suporte de notebook",
            lastPublishedAt,
            publishedCount: 1,
            channels: ["instagram_carousel"],
          },
        ],
      },
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => ({
          providerId: "MLB777",
          title: "Suporte de notebook",
          listingUrl: new URL("https://www.mercadolivre.com.br/x/p/MLB777"),
          seller: "Loja",
          availability: "available",
          listingStatus: "active",
          currentPrice: { amountMinor: 2290, currency: "BRL" },
          observedAt: new Date("2026-09-23T10:00:00Z"),
        }),
      }),
    };
    const result = await importMercadoLivreOfferTool(
      { workspaceId, productId: "MLB777", affiliateUrl: "https://meli.la/abc", nicheId: "niche-1" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({ ok: true, value: { productId: "MLB777" } });
    expect(result).not.toHaveProperty("value.warning");
  });

  it("reports CONNECTION_UNAVAILABLE when Mercado Livre does not answer the link", async () => {
    const dependencies: McpDependencies = {
      ...base(),
      affiliateLinkResolver: async () => ({ productId: null, finalUrl: null, failure: "network" }),
    };
    const result = await importMercadoLivreOfferTool(
      { workspaceId, affiliateUrl: "https://meli.la/abc" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });

  it("returns AFFILIATE_LINK_UNRESOLVED when the link is not a catalog product", async () => {
    let catalogRead = false;
    const dependencies: McpDependencies = {
      ...base(),
      affiliateLinkResolver: async () => ({
        productId: null,
        finalUrl: new URL("https://produto.mercadolivre.com.br/MLB-1-x-_JM"),
      }),
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          catalogRead = true;
          throw new Error("not_used");
        },
      }),
    };
    const result = await importMercadoLivreOfferTool(
      { workspaceId, affiliateUrl: "https://meli.la/abc" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "AFFILIATE_LINK_UNRESOLVED" });
    expect(catalogRead).toBe(false);
  });

  it("returns a clear tool error when the workspace has no Mercado Livre connection", async () => {
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      offerRepository: {
        create: async (value: unknown) => value,
        findForWorkspace: async () => null,
        listForWorkspace: async () => [],
        updateState: async () => null,
        addEvidence: async () => null,
      } as unknown as NonNullable<McpDependencies["offerRepository"]>,
      audit: { record: async () => "audit" },
      marketplaceCatalogForWorkspace: () => ({
        search: async () => [],
        readBuyerVoice: async () => {
          throw new Error("not_used");
        },
        readProductEvidence: async () => {
          throw new Error("mercado_livre_not_connected");
        },
      }),
    };

    const result = await importMercadoLivreOfferTool(
      { workspaceId, productId: "MLB1", affiliateUrl: "https://meli.la/aff" },
      actorId,
      dependencies,
    );

    expect(result).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });
});
