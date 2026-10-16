import { analyzeOfferPriceHistory } from "@money-maker/core/offers/price-intelligence";
import { summarizeBuyerVoice, type BuyerVoiceSummary } from "@money-maker/core/offers/buyer-voice";
import { buildOpportunityBrief } from "@money-maker/core/research/opportunity-brief";
import type { MarketRadarCandidate } from "@money-maker/core/research/market-radar";
import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
import { discoverMarketRadarTool } from "./discover-market-radar.js";

export const buildOpportunityBriefInputSchema = z
  .object({
    workspaceId: z.uuid(),
    offerId: z.string().trim().min(1).max(200),
    categoryId: z
      .string()
      .regex(/^MLB\d+$/)
      .optional(),
  })
  .strict();

export const buildOpportunityBriefTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = buildOpportunityBriefInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.offerRepository) return { ok: false, error: "CONNECTION_UNAVAILABLE" };

  try {
    const offer = await deps.offerRepository.findForWorkspace({
      workspaceId,
      offerId: parsed.data.offerId,
    });
    if (!offer) return { ok: false, error: "NOT_FOUND" };
    const price = analyzeOfferPriceHistory({ offer, now: new Date() });
    const listingProductId = /\b(MLB\d+)\b/.exec(offer.listingUrl)?.[1];
    const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
    let buyerVoice: BuyerVoiceSummary | undefined;
    let buyerVoiceUnavailableReason: "not_supported" | "provider_unavailable" | undefined;
    if (offer.marketplace !== "mercado_livre" || !listingProductId || !catalog) {
      buyerVoiceUnavailableReason = "not_supported";
    } else {
      try {
        buyerVoice = summarizeBuyerVoice(await catalog.readBuyerVoice(listingProductId));
      } catch {
        buyerVoiceUnavailableReason = "provider_unavailable";
      }
    }

    let marketContext: readonly MarketRadarCandidate[] | undefined;
    let marketContextStatus: "available" | "unavailable" | "not_requested" = "not_requested";
    if (parsed.data.categoryId) {
      try {
        const radar = await discoverMarketRadarTool(
          { workspaceId, categoryId: parsed.data.categoryId },
          actorId,
          deps,
        );
        if (radar.ok) {
          marketContext = (radar.value as { candidates: readonly MarketRadarCandidate[] })
            .candidates;
          marketContextStatus = "available";
        } else {
          marketContextStatus = "unavailable";
        }
      } catch {
        marketContextStatus = "unavailable";
      }
    }

    return {
      ok: true,
      value: buildOpportunityBrief({
        offer,
        price,
        ...(buyerVoice ? { buyerVoice } : {}),
        ...(buyerVoiceUnavailableReason ? { buyerVoiceUnavailableReason } : {}),
        ...(marketContext ? { marketContext } : {}),
        marketContextStatus,
      }),
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
