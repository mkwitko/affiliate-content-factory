import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
import { publicOffer } from "./offer-output.js";
export const getOfferInputSchema = z
  .object({ workspaceId: z.uuid(), offerId: z.string().trim().min(1).max(200) })
  .strict();
export const getOfferTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getOfferInputSchema.safeParse(args);
  if (!parsed.success || !deps.offerRepository)
    return parsed.success
      ? (() => {
          throw new Error("Offer repository is not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
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
  return offer
    ? { ok: true, value: { offer: publicOffer(offer) } }
    : { ok: false, error: "NOT_FOUND" };
};
