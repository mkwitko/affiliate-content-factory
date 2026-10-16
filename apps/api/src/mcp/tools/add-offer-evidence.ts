import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { addOfferEvidence } from "@money-maker/core/offers/review-offer";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
import { publicOffer } from "./offer-output.js";
const money = z
  .object({ amountMinor: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();
const fact = z
  .object({
    key: z.string().trim().min(1).max(100),
    value: z.union([z.string(), z.number().finite(), z.boolean(), money]),
    sourceUrl: z.url(),
    verified: z.boolean(),
  })
  .strict();
export const addOfferEvidenceInputSchema = z
  .object({
    workspaceId: z.uuid(),
    offerId: z.string().trim().min(1).max(200),
    snapshot: z
      .object({
        id: z.string().trim().min(1).max(200),
        verifiedAt: z.iso.datetime({ offset: true }),
        facts: z.array(fact).min(1).max(100),
      })
      .strict(),
  })
  .strict();
export const addOfferEvidenceTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = addOfferEvidenceInputSchema.safeParse(args);
  if (!parsed.success || !deps.offerRepository || !deps.audit)
    return parsed.success
      ? (() => {
          throw new Error("Offer review dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  try {
    const offer = await addOfferEvidence(
      {
        workspaceId,
        offerId: parsed.data.offerId,
        actorUserId: actorId,
        snapshot: {
          ...parsed.data.snapshot,
          verifiedAt: new Date(parsed.data.snapshot.verifiedAt),
        },
      },
      { offers: deps.offerRepository, audit: deps.audit },
    );
    return offer
      ? { ok: true, value: { offer: publicOffer(offer) } }
      : { ok: false, error: "NOT_FOUND" };
  } catch {
    return { ok: false, error: "INVALID_CONTENT" };
  }
};
