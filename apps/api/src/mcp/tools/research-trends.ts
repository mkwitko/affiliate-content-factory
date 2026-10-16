import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  hashtagFromKeyword,
  instagramHashtagLimit,
} from "@money-maker/core/content/preview-content";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const researchTrendsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    // A Mercado Livre category id such as MLB1574 (Casa); absent reads site-wide trends.
    categoryId: z
      .string()
      .regex(/^MLB\d+$/)
      .optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const researchTrendsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = researchTrendsInputSchema.safeParse(args);
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
  if (!catalog?.readTrends) throw new Error("Marketplace trends are not configured.");
  try {
    const trends = await catalog.readTrends(parsed.data.categoryId);
    return {
      ok: true,
      value: {
        source: "mercado_livre_trends",
        categoryId: parsed.data.categoryId ?? null,
        observedAt: new Date().toISOString(),
        trends: trends.slice(0, parsed.data.limit ?? 20).map((trend, index) => ({
          rank: index + 1,
          keyword: trend.keyword,
          url: trend.url,
          hashtag: hashtagFromKeyword(trend.keyword),
        })),
        instagramHashtagLimit,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "mercado_livre_not_connected")
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    if (error instanceof Error && error.message === "category_not_found")
      return { ok: false, error: "NOT_FOUND" };
    throw error;
  }
};
