import { z } from "zod";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import { createProduceOfferPackageJob } from "@money-maker/core/jobs/job";
import { importMarketplaceOffer } from "@money-maker/core/offers/import-marketplace-offer";
import { productIdFromOffer, type Offer } from "@money-maker/core/offers/offer";
import { activateOfferForWorkspace } from "@money-maker/core/offers/review-offer";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import { isMercadoLivreAffiliateHost } from "@money-maker/providers/mercado-livre/affiliate-link";
import type { McpDependencies, ToolResult } from "../server.js";
import { importListingPictures } from "./import-mercado-livre-offer.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const submitAffiliateLinksInputSchema = z
  .object({
    workspaceId: z.uuid(),
    links: z
      .array(
        z
          .object({ candidateId: z.string().trim().min(1).max(200), affiliateUrl: z.url() })
          .strict(),
      )
      .min(1)
      .max(25)
      .refine((links) => new Set(links.map((link) => link.candidateId)).size === links.length, {
        message: "candidateId values must be unique",
      }),
  })
  .strict();

type LinkResult = Readonly<{
  candidateId: string;
  status:
    | "linked"
    | "already_linked"
    | "invalid"
    | "wrong_product"
    | "expired_candidate"
    | "import_failed";
  reason?: string;
  retryable?: boolean;
  offerId?: string;
  offerState?: "active" | "draft";
  activationError?: string;
  jobId?: string;
}>;

const ALREADY_LINKED_STATES: readonly ProductCandidate["state"][] = [
  "linked",
  "in_production",
  "consumed",
];

const alreadyLinkedOrExpired = (candidate: ProductCandidate): LinkResult =>
  ALREADY_LINKED_STATES.includes(candidate.state)
    ? {
        candidateId: candidate.id,
        status: "already_linked",
        ...(candidate.offerId ? { offerId: candidate.offerId } : {}),
      }
    : { candidateId: candidate.id, status: "expired_candidate" };

export const submitAffiliateLinksTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = submitAffiliateLinksInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const { productCandidateRepository: candidates, offerRepository: offers, audit } = deps;
  if (!candidates || !offers?.listForWorkspace || !audit || !deps.affiliateLinkResolver)
    throw new Error("Affiliate link submission dependencies are not configured.");
  if (!deps.jobQueue) throw new Error("Job queue is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!catalog) throw new Error("Mercado Livre import dependencies are not configured.");
  const resolveLink = deps.affiliateLinkResolver;
  const listOffers = offers.listForWorkspace.bind(offers);
  const jobQueue = deps.jobQueue;

  const submit = async (link: {
    candidateId: string;
    affiliateUrl: string;
  }): Promise<LinkResult> => {
    const candidateId = link.candidateId;
    const candidate = await candidates.findForWorkspace({ workspaceId, id: candidateId });
    if (!candidate) return { candidateId, status: "invalid", reason: "unknown_candidate" };
    if (candidate.state !== "awaiting_affiliate_link") return alreadyLinkedOrExpired(candidate);

    const url = new URL(link.affiliateUrl);
    if (url.protocol !== "https:" || !isMercadoLivreAffiliateHost(url.hostname))
      return { candidateId, status: "invalid", reason: "host_not_allowed" };
    // Always resolve: the link must lead to this candidate's own catalog product.
    const resolved = await resolveLink(url);
    if (resolved.productId === null)
      return resolved.failure === "network"
        ? {
            candidateId,
            status: "import_failed",
            reason: "link_check_unavailable",
            retryable: true,
          }
        : { candidateId, status: "invalid", reason: "unsupported_redirect" };
    if (resolved.productId !== candidate.providerId)
      return { candidateId, status: "wrong_product" };

    const claimed = await candidates.transition({
      workspaceId,
      id: candidateId,
      from: ["awaiting_affiliate_link"],
      to: "linked",
      at: new Date(),
    });
    if (!claimed) {
      const current = await candidates.findForWorkspace({ workspaceId, id: candidateId });
      return current
        ? alreadyLinkedOrExpired(current)
        : { candidateId, status: "invalid", reason: "unknown_candidate" };
    }

    try {
      const existing = (await listOffers(workspaceId)).find(
        (offer) =>
          offer.marketplace === "mercado_livre" &&
          (offer.state === "draft" || offer.state === "active") &&
          Boolean(offer.affiliateUrl) &&
          productIdFromOffer(offer) === candidate.providerId,
      );
      const offer: Offer = existing
        ? existing
        : (
            await importMarketplaceOffer(
              {
                workspaceId,
                actorUserId: actorId,
                productId: candidate.providerId,
                affiliateUrl: link.affiliateUrl,
                catalog,
              },
              {
                offers,
                audit,
                importPictures: ({ evidence }) =>
                  importListingPictures(deps, workspaceId, evidence),
              },
            )
          ).offer;
      let active = offer.state === "active";
      let activationError: string | undefined;
      if (!active) {
        try {
          active =
            (await activateOfferForWorkspace(
              { workspaceId, offerId: offer.id, actorUserId: actorId },
              { offers, audit },
            )) !== null;
          if (!active) activationError = "activation_failed";
        } catch (error) {
          activationError = error instanceof Error ? error.message : "activation_failed";
        }
      }
      const attached = await candidates.transition({
        workspaceId,
        id: candidateId,
        from: ["linked"],
        to: "linked",
        at: new Date(),
        offerId: offer.id,
      });
      // The row moved on (rejected, released): do not package an offer no candidate holds.
      if (!attached)
        return { candidateId, status: "import_failed", reason: "claim_lost", retryable: false };
      // A draft offer cannot be packaged; the candidate stays linked for a later retry.
      const queued = active
        ? await jobQueue.enqueue(createProduceOfferPackageJob({ workspaceId, offerId: offer.id }))
        : undefined;
      return {
        candidateId,
        status: "linked",
        offerId: offer.id,
        offerState: active ? "active" : "draft",
        ...(activationError ? { activationError } : {}),
        ...(queued ? { jobId: queued.id } : {}),
      };
    } catch (error) {
      await releaseClaim(candidates, workspaceId, candidateId);
      return {
        candidateId,
        status: "import_failed",
        reason:
          error instanceof Error && error.message === "mercado_livre_not_connected"
            ? "connection_unavailable"
            : "import_failed",
        retryable: true,
      };
    }
  };

  const results: LinkResult[] = [];
  // Sequential on purpose: bounds provider load and keeps each claim/import/enqueue ordered.
  for (const link of parsed.data.links) results.push(await submit(link));
  return { ok: true, value: { results } };
};

const releaseClaim = async (
  candidates: NonNullable<McpDependencies["productCandidateRepository"]>,
  workspaceId: WorkspaceId,
  id: string,
): Promise<void> => {
  try {
    await candidates.transition({
      workspaceId,
      id,
      from: ["linked"],
      to: "awaiting_affiliate_link",
      at: new Date(),
      offerId: null,
    });
  } catch {
    // The row stays linked without an offer; the autonomy cycle repairs it.
  }
};
