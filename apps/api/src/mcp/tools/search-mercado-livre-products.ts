import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { isProductInCooldown } from "@money-maker/core/offers/product-posting-history";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const searchMercadoLivreProductsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(100),
    // Optional: search is niche-agnostic, but a niche in scope lets the response say which
    // products are in that niche's post cooldown. Absent, every item reports "not in cooldown".
    nicheId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
// Mercado Livre has no official affiliate-link API, so the operator generates the link here.
export const mercadoLivreAffiliateLinkBuilderUrl =
  "https://www.mercadolivre.com.br/afiliados/linkbuilder";
export const searchMercadoLivreProductsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = searchMercadoLivreProductsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!catalog) throw new Error("Marketplace catalog is not configured.");
  const nicheId = parsed.data.nicheId;
  if (nicheId && !deps.productPostingHistoryRepository) {
    throw new Error("Product posting history repository is not configured.");
  }
  try {
    const products = await catalog.search({ query: parsed.data.query, limit: parsed.data.limit });
    const history = nicheId
      ? await deps.productPostingHistoryRepository?.productPostingHistory({ workspaceId, nicheId })
      : undefined;
    const byProductId = new Map((history ?? []).map((entry) => [entry.productId, entry]));
    return {
      ok: true,
      value: {
        products: products.map((product) => {
          const entry = byProductId.get(product.providerId);
          return {
            ...product,
            listingUrl: product.listingUrl.toString(),
            lastPostedAt: entry ? entry.lastPublishedAt.toISOString() : null,
            postedCount: entry?.publishedCount ?? 0,
            inCooldown: entry ? isProductInCooldown(entry.lastPublishedAt) : false,
          };
        }),
        affiliateLinkBuilderUrl: mercadoLivreAffiliateLinkBuilderUrl,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "mercado_livre_not_connected") {
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    }
    throw error;
  }
};
