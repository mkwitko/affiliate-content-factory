import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { isProductInCooldown } from "@money-maker/core/offers/product-posting-history";
import type { McpDependencies, ToolResult } from "../server.js";
import { mercadoLivreAffiliateLinkBuilderUrl } from "./search-mercado-livre-products.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const listProductCandidatesInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    since: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const listProductCandidatesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listProductCandidatesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (
    !deps.nicheRepository ||
    !deps.productCandidateRepository ||
    !deps.productPostingHistoryRepository
  )
    throw new Error("Product candidate dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const niche = await deps.nicheRepository.findForWorkspace({
    workspaceId,
    nicheId: parsed.data.nicheId,
  });
  if (!niche) return { ok: false, error: "INVALID_ARGUMENTS" };
  const [candidates, history] = await Promise.all([
    deps.productCandidateRepository.listForNiche({
      workspaceId,
      nicheId: parsed.data.nicheId,
      ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    }),
    deps.productPostingHistoryRepository.productPostingHistory({
      workspaceId,
      nicheId: parsed.data.nicheId,
    }),
  ]);
  const byProductId = new Map(history.map((entry) => [entry.productId, entry]));
  return {
    ok: true,
    value: {
      candidates: candidates.map((candidate) => {
        const entry = byProductId.get(candidate.providerId);
        return {
          ...candidate,
          lastPostedAt: entry ? entry.lastPublishedAt.toISOString() : null,
          postedCount: entry?.publishedCount ?? 0,
          inCooldown: entry ? isProductInCooldown(entry.lastPublishedAt) : false,
        };
      }),
      affiliateLinkBuilderUrl: mercadoLivreAffiliateLinkBuilderUrl,
    },
  };
};
