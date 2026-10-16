import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { MercadoLivreRequestError } from "@money-maker/providers/mercado-livre/catalog";
import { checkOfferStatusTool } from "./check-offer-status.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const url = "https://www.mercadolivre.com.br/suporte/p/MLB777";
const offer = {
  id: "o1",
  workspaceId,
  listingUrl: url,
  snapshots: [
    {
      id: "ml-MLB777-1",
      verifiedAt: new Date("2026-09-20T10:00:00Z"),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 3790, currency: "BRL" },
          sourceUrl: url,
          verified: true,
        },
        { key: "free_shipping", value: true, sourceUrl: url, verified: true },
      ],
    },
  ],
};
const deps = (read: (productId: string) => Promise<unknown>) =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {},
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "operator",
        status: "active",
      }),
    },
    offerRepository: { findForWorkspace: async () => offer },
    marketplaceCatalogForWorkspace: () => ({ readProductEvidence: read }),
  }) as unknown as McpDependencies;
const evidence = (overrides: Record<string, unknown> = {}) => ({
  providerId: "MLB777",
  title: "Suporte",
  listingUrl: new URL(url),
  seller: "Loja",
  availability: "available",
  currentPrice: { amountMinor: 3790, currency: "BRL" },
  freeShipping: true,
  observedAt: new Date("2026-09-24T10:00:00Z"),
  ...overrides,
});

describe("check_offer_status", () => {
  it("reports unchanged when price and shipping match the evidence", async () => {
    const seen: string[] = [];
    const result = await checkOfferStatusTool(
      { workspaceId, offerId: "o1" },
      actorId,
      deps(async (id) => {
        seen.push(id);
        return evidence();
      }),
    );
    expect(seen).toEqual(["MLB777"]);
    expect(result).toMatchObject({ ok: true, value: { status: "unchanged", changes: [] } });
  });

  it("lists what changed", async () => {
    const result = await checkOfferStatusTool(
      { workspaceId, offerId: "o1" },
      actorId,
      deps(async () =>
        evidence({ currentPrice: { amountMinor: 4290, currency: "BRL" }, freeShipping: false }),
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "changed",
        changes: [
          { key: "current_price", was: { amountMinor: 3790 }, now: { amountMinor: 4290 } },
          { key: "free_shipping", was: true, now: false },
        ],
      },
    });
  });

  it("reports an offer Mercado Livre no longer sells as unavailable", async () => {
    const result = await checkOfferStatusTool(
      { workspaceId, offerId: "o1" },
      actorId,
      deps(async () => {
        throw new Error("listing_unavailable");
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { status: "unavailable" } });
  });

  it("treats a product Mercado Livre no longer serves (404) as unavailable", async () => {
    const result = await checkOfferStatusTool(
      { workspaceId, offerId: "o1" },
      actorId,
      deps(async () => {
        throw new MercadoLivreRequestError("provider_request_failed", 404, undefined);
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { status: "unavailable" } });
  });

  it("denies a non-member and hides an offer outside the workspace", async () => {
    const outsider = {
      ...deps(async () => evidence()),
      workspaces: { findMembership: async () => null },
    } as unknown as McpDependencies;
    await expect(
      checkOfferStatusTool({ workspaceId, offerId: "o1" }, actorId, outsider),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });
    const missing = {
      ...deps(async () => evidence()),
      offerRepository: { findForWorkspace: async () => null },
    } as unknown as McpDependencies;
    await expect(
      checkOfferStatusTool({ workspaceId, offerId: "o1" }, actorId, missing),
    ).resolves.toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
