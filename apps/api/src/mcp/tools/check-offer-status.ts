import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { ProductEvidence } from "@money-maker/core/offers/marketplace-catalog";
import { productIdFromOffer } from "@money-maker/core/offers/offer";
import type { CommercialFactValue } from "@money-maker/core/offers/offer";
import { MercadoLivreRequestError } from "@money-maker/providers/mercado-livre/catalog";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const checkOfferStatusInputSchema = z
  .object({ workspaceId: z.uuid(), offerId: z.string().trim().min(1).max(200) })
  .strict()
  .describe(
    "Read the offer on Mercado Livre now and compare it with the evidence the posts were built from. Read-only: it never changes the offer.",
  );

/** Facts a buyer would notice changing between the post and the listing. */
const watchedFacts = ["current_price", "list_price", "free_shipping"] as const;

const currentValue = (
  evidence: ProductEvidence,
  key: (typeof watchedFacts)[number],
): CommercialFactValue | undefined =>
  key === "current_price"
    ? evidence.currentPrice
    : key === "list_price"
      ? evidence.listPrice
      : evidence.freeShipping;

export const checkOfferStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = checkOfferStatusInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.offerRepository) throw new Error("Offer repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const offer = await deps.offerRepository.findForWorkspace({
    workspaceId,
    offerId: parsed.data.offerId,
  });
  if (!offer) return { ok: false, error: "NOT_FOUND" };
  const snapshot = [...offer.snapshots].sort(
    (left, right) => right.verifiedAt.getTime() - left.verifiedAt.getTime(),
  )[0];
  const productId = productIdFromOffer(offer);
  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!snapshot || !productId || !catalog) return { ok: false, error: "INVALID_CONTENT" };
  let evidence: ProductEvidence;
  try {
    evidence = await catalog.readProductEvidence(productId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "mercado_livre_not_connected")
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    const delisted = error instanceof MercadoLivreRequestError && error.status === 404;
    if (reason === "listing_unavailable" || reason === "no_active_offer" || delisted) {
      return { ok: true, value: { offerId: offer.id, status: "unavailable", changes: [] } };
    }
    throw error;
  }
  const known = new Map(snapshot.facts.map((fact) => [fact.key, fact.value]));
  const changes = watchedFacts.flatMap((key) => {
    const was = known.get(key);
    const now = currentValue(evidence, key);
    return JSON.stringify(was) === JSON.stringify(now)
      ? []
      : [{ key, was: was ?? null, now: now ?? null }];
  });
  return {
    ok: true,
    value: {
      offerId: offer.id,
      status: changes.length > 0 ? "changed" : "unchanged",
      changes,
      evidenceVerifiedAt: snapshot.verifiedAt,
      checkedAt: evidence.observedAt,
    },
  };
};
