import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Offer } from "@money-maker/core/offers/offer";
import type { McpDependencies } from "../server.js";
import { analyzeOfferPriceHistoryTool } from "./analyze-offer-price-history.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/item",
  title: "Item",
  state: "active",
  snapshots: [],
};

const deps = (
  findForWorkspace: (input: {
    workspaceId: typeof workspaceId;
    offerId: string;
  }) => Promise<Offer | null>,
  member = true,
): McpDependencies =>
  ({
    workspaces: {
      findMembership: async () =>
        member ? { workspaceId, userId, role: "owner", status: "active" } : null,
    },
    offerRepository: { findForWorkspace: vi.fn(findForWorkspace) },
  }) as unknown as McpDependencies;

describe("analyze_offer_price_history MCP tool", () => {
  it("reads the workspace-scoped offer and returns the existing-snapshot analysis", async () => {
    const findForWorkspace = vi.fn(async () => offer);
    const result = await analyzeOfferPriceHistoryTool(
      { workspaceId, offerId: offer.id },
      userId,
      deps(findForWorkspace),
    );
    expect(findForWorkspace).toHaveBeenCalledWith({ workspaceId, offerId: offer.id });
    expect(result).toMatchObject({
      ok: true,
      value: {
        offerId: offer.id,
        isRealDeal: null,
        reason: "current_price_unverified",
        sampleCount30d: 0,
      },
    });
  });

  it("rejects invalid input, denies outsiders, and hides missing offers", async () => {
    const findForWorkspace = vi.fn(async () => null);
    const outsider = deps(findForWorkspace, false);
    expect(
      await analyzeOfferPriceHistoryTool({ workspaceId, offerId: " " }, userId, outsider),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(
      await analyzeOfferPriceHistoryTool({ workspaceId, offerId: "missing" }, userId, outsider),
    ).toMatchObject({ ok: false });
    expect(findForWorkspace).not.toHaveBeenCalled();
    expect(
      await analyzeOfferPriceHistoryTool(
        { workspaceId, offerId: "missing" },
        userId,
        deps(findForWorkspace),
      ),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("maps repository failures to a stable error", async () => {
    expect(
      await analyzeOfferPriceHistoryTool(
        { workspaceId, offerId: offer.id },
        userId,
        deps(async () => {
          throw new Error("sensitive database details");
        }),
      ),
    ).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });
});
