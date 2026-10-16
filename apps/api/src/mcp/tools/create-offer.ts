import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createOfferForWorkspace } from "@money-maker/core/offers/create-offer";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

const moneySchema = z
  .object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();

export const createOfferInputSchema = z
  .object({
    workspaceId: z.uuid(),
    listingUrl: z.url(),
    affiliateUrl: z.url().optional(),
    title: z.string().trim().min(1).max(500),
    listPrice: moneySchema.optional(),
    currentPrice: moneySchema.optional(),
    discount: moneySchema.optional(),
    shipping: moneySchema.optional(),
    commission: moneySchema.optional(),
    fees: moneySchema.optional(),
    revenue: moneySchema.optional(),
  })
  .strict()
  .describe("Register a manual Mercado Livre affiliate offer with safe commercial fields.");

export const createOfferTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createOfferInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!dependencies.offerRepository || !dependencies.audit) {
    throw new Error("Offer dependencies are not configured.");
  }

  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles: ["owner", "operator"],
  });
  if (!authorization.ok) return { ok: false, error: "FORBIDDEN" };

  const offer = await createOfferForWorkspace(
    {
      workspaceId,
      marketplace: "mercado_livre",
      listingUrl: parsed.data.listingUrl,
      title: parsed.data.title,
      actorUserId: actorId,
      ...(parsed.data.affiliateUrl ? { affiliateUrl: parsed.data.affiliateUrl } : {}),
      ...(parsed.data.listPrice ? { listPrice: parsed.data.listPrice } : {}),
      ...(parsed.data.currentPrice ? { currentPrice: parsed.data.currentPrice } : {}),
      ...(parsed.data.discount ? { discount: parsed.data.discount } : {}),
      ...(parsed.data.shipping ? { shipping: parsed.data.shipping } : {}),
      ...(parsed.data.commission ? { commission: parsed.data.commission } : {}),
      ...(parsed.data.fees ? { fees: parsed.data.fees } : {}),
      ...(parsed.data.revenue ? { revenue: parsed.data.revenue } : {}),
    },
    { offers: dependencies.offerRepository, audit: dependencies.audit },
  );
  return { ok: true, value: { offer } };
};
