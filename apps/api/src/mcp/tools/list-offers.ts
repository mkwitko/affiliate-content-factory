import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument, requireList } from "./workspace-access.js";
import { publicOffer } from "./offer-output.js";
export const listOffersInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const listOffersTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listOffersInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const offers = await requireList(deps.offerRepository)(workspaceId);
  return { ok: true, value: { offers: offers.map(publicOffer) } };
};
