import type { UserId } from "@money-maker/contracts";
import { analyzeOfferPriceHistory } from "@money-maker/core/offers/price-intelligence";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const analyzeOfferPriceHistoryInputSchema = z
  .object({ workspaceId: z.uuid(), offerId: z.string().trim().min(1).max(200) })
  .strict();

export const analyzeOfferPriceHistoryTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = analyzeOfferPriceHistoryInputSchema.safeParse(args);
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
    return {
      ok: true,
      value: analyzeOfferPriceHistory({ offer, now: new Date() }),
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
