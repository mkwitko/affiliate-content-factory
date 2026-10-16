import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { isTikTokShopListingUrl } from "@money-maker/core/offers/offer";
import { createOfferForWorkspace } from "@money-maker/core/offers/create-offer";
import {
  addOfferEvidence,
  activateOfferForWorkspace,
  refreshOfferEvidence,
} from "@money-maker/core/offers/review-offer";
import {
  commercialFactsFromTikTokShopObservation,
  type TikTokShopProductObservation,
} from "@money-maker/core/offers/commercial-facts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
import { publicOffer } from "./offer-output.js";

const externalProductIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,100}$/);

export const importTikTokShopProductInputSchema = z
  .object({
    workspaceId: z.uuid(),
    productUrl: z.url(),
    externalProductId: externalProductIdSchema,
    title: z.string().trim().min(1).max(300),
    seller: z.string().trim().min(1).max(200),
    currentPriceMinor: z.number().int().min(0),
    listPriceMinor: z.number().int().min(0).optional(),
    commissionPercent: z.number().min(0).max(100),
    commissionPlan: z.enum(["open", "targeted"]).optional(),
    sampleAvailable: z.boolean().optional(),
    category: z.string().trim().min(1).max(200).optional(),
    stockStatus: z.enum(["in_stock", "low_stock", "out_of_stock"]).optional(),
  })
  .strict()
  .describe(
    "Register (or refresh) an operator-observed TikTok Shop product as a draft-then-active offer. The operator reads price, seller, and commission directly off the Creator Product Marketplace or product page; this tool never fetches or scrapes.",
  );

export const importTikTokShopProductTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = importTikTokShopProductInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.offerRepository || !deps.audit)
    throw new Error("TikTok Shop import dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;

  let productUrl: URL;
  try {
    productUrl = new URL(parsed.data.productUrl);
  } catch {
    return { ok: false, error: "INVALID_ARGUMENTS" };
  }
  if (!isTikTokShopListingUrl(productUrl)) return { ok: false, error: "INVALID_ARGUMENTS" };

  const now = new Date();
  const currency = "BRL" as const;
  // ponytail: a raw discount computation would go negative/zero when the operator mistypes
  // listPrice <= currentPrice; only feed listPrice into the observation when it is a real markdown.
  const listPrice =
    parsed.data.listPriceMinor !== undefined &&
    parsed.data.listPriceMinor > parsed.data.currentPriceMinor
      ? { amountMinor: parsed.data.listPriceMinor, currency }
      : undefined;
  const observation: TikTokShopProductObservation = {
    productId: parsed.data.externalProductId,
    seller: parsed.data.seller,
    currentPrice: { amountMinor: parsed.data.currentPriceMinor, currency },
    ...(listPrice ? { listPrice } : {}),
    commissionPercent: parsed.data.commissionPercent,
    ...(parsed.data.commissionPlan ? { commissionPlan: parsed.data.commissionPlan } : {}),
    ...(parsed.data.sampleAvailable !== undefined
      ? { sampleAvailable: parsed.data.sampleAvailable }
      : {}),
    ...(parsed.data.category ? { category: parsed.data.category } : {}),
    ...(parsed.data.stockStatus ? { stockStatus: parsed.data.stockStatus } : {}),
    productUrl: parsed.data.productUrl,
  };
  const snapshot = {
    id: `tiktokshop-${parsed.data.externalProductId}-${now.getTime()}`,
    verifiedAt: now,
    facts: commercialFactsFromTikTokShopObservation(observation),
  };

  const deps_ = { offers: deps.offerRepository, audit: deps.audit };
  const existing = await deps.offerRepository.findByExternalProductForWorkspace?.({
    workspaceId,
    marketplace: "tiktok_shop",
    externalProductId: parsed.data.externalProductId,
  });

  const offerId = existing
    ? existing.id
    : (
        await createOfferForWorkspace(
          {
            workspaceId,
            marketplace: "tiktok_shop",
            listingUrl: parsed.data.productUrl,
            externalProductId: parsed.data.externalProductId,
            title: parsed.data.title,
            currentPrice: { amountMinor: parsed.data.currentPriceMinor, currency },
            actorUserId: actorId,
          },
          deps_,
        )
      ).id;

  const withEvidence = existing
    ? await refreshOfferEvidence({ workspaceId, offerId, actorUserId: actorId, snapshot }, deps_)
    : await addOfferEvidence({ workspaceId, offerId, actorUserId: actorId, snapshot }, deps_);
  if (!withEvidence) return { ok: false, error: "NOT_FOUND" };

  const activated = await activateOfferForWorkspace(
    { workspaceId, offerId, actorUserId: actorId, now },
    deps_,
  );
  if (!activated) return { ok: false, error: "NOT_FOUND" };

  return { ok: true, value: { offer: publicOffer(activated) } };
};
