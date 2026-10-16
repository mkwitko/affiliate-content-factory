import { z } from "zod";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import { importMarketplaceOffer } from "@money-maker/core/offers/import-marketplace-offer";
import type { ProductEvidence } from "@money-maker/core/offers/marketplace-catalog";
import { isProductInCooldown } from "@money-maker/core/offers/product-posting-history";
import { isMercadoLivreAffiliateHost } from "@money-maker/providers/mercado-livre/affiliate-link";
import { storeFetchedImage } from "./import-asset-from-url.js";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const importMercadoLivreOfferInputSchema = z
  .object({
    workspaceId: z.uuid(),
    productId: z.string().trim().min(1).max(200).optional(),
    affiliateUrl: z.url(),
    // Optional: when given, a product still in that niche's post cooldown gets a
    // `recently_posted` warning instead of being silently re-imported.
    nicheId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
/** Imports up to four official listing photos as assets; returns the ids that were stored. */
export const importListingPictures = async (
  deps: McpDependencies,
  workspaceId: WorkspaceId,
  evidence: ProductEvidence,
): Promise<readonly string[]> => {
  const pictureAssetIds: string[] = [];
  if (!deps.assetRepository || !deps.assetStore) return pictureAssetIds;
  for (const picture of (evidence.pictures ?? []).slice(0, 4)) {
    const imported = await storeFetchedImage(deps, {
      workspaceId,
      url: new URL(picture.url),
      canvas: undefined,
      fit: "contain",
      provenance: "provider_import",
      license: "Mercado Livre listing photo",
      metadata: {
        role: "listing_picture",
        productId: evidence.providerId,
        position: picture.position,
      },
    });
    if (
      imported.ok &&
      typeof imported.value.asset === "object" &&
      imported.value.asset !== null &&
      "id" in imported.value.asset &&
      typeof imported.value.asset.id === "string"
    ) {
      pictureAssetIds.push(imported.value.asset.id);
    }
  }
  return pictureAssetIds;
};

export const importMercadoLivreOfferTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = importMercadoLivreOfferInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.offerRepository || !deps.audit)
    throw new Error("Mercado Livre import dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const nicheId = parsed.data.nicheId;
  if (nicheId && !deps.productPostingHistoryRepository) {
    throw new Error("Product posting history repository is not configured.");
  }
  const affiliateUrl = new URL(parsed.data.affiliateUrl);
  if (!isMercadoLivreAffiliateHost(affiliateUrl.hostname)) {
    return { ok: false, error: "INVALID_ARGUMENTS" };
  }
  let productId = parsed.data.productId;
  if (!productId) {
    if (!deps.affiliateLinkResolver) throw new Error("Affiliate link resolver is not configured.");
    const resolved = await deps.affiliateLinkResolver(affiliateUrl);
    if (resolved.productId === null) {
      return {
        ok: false,
        error:
          resolved.failure === "network" ? "CONNECTION_UNAVAILABLE" : "AFFILIATE_LINK_UNRESOLVED",
      };
    }
    productId = resolved.productId;
  }
  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!catalog) throw new Error("Mercado Livre import dependencies are not configured.");
  let imported: Awaited<ReturnType<typeof importMarketplaceOffer>>;
  try {
    imported = await importMarketplaceOffer(
      {
        workspaceId,
        actorUserId: actorId,
        productId,
        affiliateUrl: parsed.data.affiliateUrl,
        catalog,
      },
      {
        offers: deps.offerRepository,
        audit: deps.audit,
        importPictures: ({ evidence }) => importListingPictures(deps, workspaceId, evidence),
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "mercado_livre_not_connected") {
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    }
    throw error;
  }
  const { offer, evidence, pictureAssetIds } = imported;
  const cooldownEntry = nicheId
    ? (
        await deps.productPostingHistoryRepository?.productPostingHistory({ workspaceId, nicheId })
      )?.find((entry) => entry.productId === evidence.providerId)
    : undefined;
  const warning =
    cooldownEntry && isProductInCooldown(cooldownEntry.lastPublishedAt)
      ? {
          code: "recently_posted" as const,
          lastPostedAt: cooldownEntry.lastPublishedAt.toISOString(),
        }
      : undefined;
  return {
    ok: true,
    value: {
      offer,
      productId: evidence.providerId,
      affiliateProvenance: "operator_supplied",
      pictureAssetIds,
      ...(warning ? { warning } : {}),
    },
  };
};
