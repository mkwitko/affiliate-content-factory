import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Offer } from "@money-maker/core/offers/offer";
import {
  addRefreshedSnapshot,
  addEvidenceSnapshot,
  activateOffer,
} from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { AuditPort } from "@money-maker/core/audit/audit-port";
import type { McpDependencies } from "../server.js";
import { importTikTokShopProductTool } from "./import-tiktok-shop-product.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces = (role: "owner" | "operator" | "reviewer" | "other"): WorkspaceRepository => ({
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () =>
    role === "other" ? null : { workspaceId, userId: actorId, role, status: "active" },
  addMembership: async () => undefined,
});

const baseInput = {
  workspaceId,
  productUrl: "https://shop.tiktok.com/view/product/1729999999999999999",
  externalProductId: "1729999999999999999",
  title: "Fone Bluetooth",
  seller: "Loja Oficial",
  currentPriceMinor: 9990,
  listPriceMinor: 14990,
  commissionPercent: 12,
  commissionPlan: "open" as const,
  sampleAvailable: true,
  category: "Eletrônicos",
  stockStatus: "in_stock" as const,
};

const fixture = (
  role: "owner" | "operator" | "reviewer" | "other" = "operator",
  seedOffer?: Offer,
) => {
  let stored: Offer | undefined = seedOffer;
  const audit: AuditPort = { record: async () => "audit-1" };
  const offerRepository: OfferRepository = {
    create: async (offer) => (stored = offer),
    findForWorkspace: async ({ workspaceId: target, offerId }) =>
      stored && stored.workspaceId === target && stored.id === offerId ? stored : null,
    findByExternalProductForWorkspace: async ({
      workspaceId: target,
      marketplace,
      externalProductId,
    }) =>
      stored &&
      stored.workspaceId === target &&
      stored.marketplace === marketplace &&
      stored.externalProductId === externalProductId
        ? stored
        : null,
    addSnapshot: async ({ workspaceId: target, offerId, snapshot }) => {
      if (!stored || stored.workspaceId !== target || stored.id !== offerId) return null;
      stored =
        stored.state === "draft"
          ? addEvidenceSnapshot(stored, snapshot)
          : addRefreshedSnapshot(stored, snapshot);
      return stored;
    },
    activate: async ({ workspaceId: target, offerId }) => {
      if (!stored || stored.workspaceId !== target || stored.id !== offerId) return null;
      stored = activateOffer(stored);
      return stored;
    },
    reject: async () => stored ?? null,
  };
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: workspaces(role),
    offerRepository,
    audit,
  };
  return { dependencies, offer: () => stored };
};

describe("import_tiktok_shop_product MCP tool", () => {
  it("creates and activates a new TikTok Shop offer with a derived discount", async () => {
    const { dependencies, offer } = fixture();
    const result = await importTikTokShopProductTool(baseInput, actorId, dependencies);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const value = result.value as {
      offer: { state: string; snapshots: Array<{ facts: unknown[] }> };
    };
    expect(value.offer.state).toBe("active");
    const facts = value.offer.snapshots[0]?.facts as Array<{ key: string; value: unknown }>;
    expect(facts.find((f) => f.key === "discount_percent")?.value).toBe(33);
    expect(facts.find((f) => f.key === "commission_percent")?.value).toBe(12);
    expect(offer()?.externalProductId).toBe(baseInput.externalProductId);
    expect(offer()?.marketplace).toBe("tiktok_shop");
  });

  it("omits list_price and discount_percent when listPrice is not above currentPrice", async () => {
    const { dependencies } = fixture();
    const result = await importTikTokShopProductTool(
      { ...baseInput, listPriceMinor: 9990 },
      actorId,
      dependencies,
    );
    if (!result.ok) throw new Error("expected ok");
    const value = result.value as {
      offer: { snapshots: Array<{ facts: Array<{ key: string }> }> };
    };
    const keys = value.offer.snapshots[0]?.facts.map((f) => f.key) ?? [];
    expect(keys).not.toContain("list_price");
    expect(keys).not.toContain("discount_percent");
  });

  it("refreshes and re-activates an existing offer for the same externalProductId", async () => {
    const seed: Offer = {
      id: "offer-1",
      workspaceId,
      marketplace: "tiktok_shop",
      listingUrl: baseInput.productUrl,
      externalProductId: baseInput.externalProductId,
      title: baseInput.title,
      state: "active",
      activeSnapshotId: "seed-snapshot",
      snapshots: [
        {
          id: "seed-snapshot",
          verifiedAt: new Date("2026-09-20T00:00:00.000Z"),
          facts: [
            {
              key: "product_id",
              value: baseInput.externalProductId,
              sourceUrl: baseInput.productUrl,
              verified: true,
            },
            {
              key: "seller",
              value: baseInput.seller,
              sourceUrl: baseInput.productUrl,
              verified: true,
            },
            {
              key: "current_price",
              value: { amountMinor: 8990, currency: "BRL" },
              sourceUrl: baseInput.productUrl,
              verified: true,
            },
            {
              key: "commission_percent",
              value: 10,
              sourceUrl: baseInput.productUrl,
              verified: true,
            },
          ],
        },
      ],
    };
    const { dependencies, offer } = fixture("operator", seed);
    const result = await importTikTokShopProductTool(baseInput, actorId, dependencies);
    expect(result.ok).toBe(true);
    expect(offer()?.snapshots).toHaveLength(2);
    expect(offer()?.activeSnapshotId).not.toBe("seed-snapshot");
  });

  it("rejects a non-TikTok productUrl", async () => {
    const { dependencies } = fixture();
    const result = await importTikTokShopProductTool(
      { ...baseInput, productUrl: "https://example.com/product/1" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects an invalid externalProductId", async () => {
    const { dependencies } = fixture();
    const result = await importTikTokShopProductTool(
      { ...baseInput, externalProductId: "has spaces!" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects a negative currentPriceMinor", async () => {
    const { dependencies } = fixture();
    const result = await importTikTokShopProductTool(
      { ...baseInput, currentPriceMinor: -1 },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects a commissionPercent above 100", async () => {
    const { dependencies } = fixture();
    const result = await importTikTokShopProductTool(
      { ...baseInput, commissionPercent: 101 },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a reviewer (owner/operator only)", async () => {
    const { dependencies } = fixture("reviewer");
    const result = await importTikTokShopProductTool(baseInput, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("denies a non-member", async () => {
    const { dependencies } = fixture("other");
    const result = await importTikTokShopProductTool(baseInput, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
