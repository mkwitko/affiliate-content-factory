import type { UserId } from "@money-maker/contracts";
import { summarizeCreativePatterns } from "@money-maker/core/analytics/creative-intelligence";
import { armOf } from "@money-maker/core/analytics/learnings";
import { learningFeatures } from "@money-maker/core/content/content";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getPerformanceSummaryInputSchema = z
  .object({
    workspaceId: z.uuid(),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("Only posts published at or after this time."),
    groupBy: z
      .enum(learningFeatures)
      .optional()
      .describe(
        "Also return per-arm means and counts for this creative feature (no significance rule).",
      ),
    limit: z.number().int().min(1).max(500).default(200).describe("Newest posts first."),
  })
  .strict();

/**
 * A pattern with insufficient data says nothing yet, and listing every one made this output
 * 75 KB for 56 posts (197 patterns, none sufficient): counted, not listed.
 */
const patternsWithData = <T extends Readonly<{ sufficiency: string }>>(patterns: readonly T[]) => ({
  creativePatterns: patterns.filter((pattern) => pattern.sufficiency !== "insufficient_data"),
  insufficientPatterns: patterns.filter((pattern) => pattern.sufficiency === "insufficient_data")
    .length,
});

export const getPerformanceSummaryTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getPerformanceSummaryInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.performanceRepository || !deps.attributionRepository)
    throw new Error("Performance dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const since = parsed.data.since ? new Date(parsed.data.since) : undefined;
  const [posts, clicks] = await Promise.all([
    deps.performanceRepository.latestByVariant(workspaceId, {
      limit: parsed.data.limit,
      ...(since ? { since } : {}),
    }),
    deps.attributionRepository.summary(workspaceId, {
      groupBy: "variant",
      ...(since ? { since } : {}),
    }),
  ]);
  const clicksByVariant = new Map(clicks.map((row) => [row.key, row]));
  const performancePosts = posts.map((post) => {
    const click = clicksByVariant.get(post.contentVariantId);
    const audience = post.metrics.reach ?? post.metrics.views;
    return {
      contentVariantId: post.contentVariantId,
      channelId: post.channelId,
      publishedAt: post.publishedAt,
      observedAt: post.observedAt,
      platformUrl: post.platformUrl ?? null,
      metrics: post.metrics,
      creativeFeatures: post.creativeFeatures,
      clicks: click?.clicks ?? 0,
      uniqueClicks: click?.uniqueClicks ?? 0,
      // Calculated, never observed: clicks over reach (or views when reach is missing).
      clickRate:
        audience && click ? Math.round((click.uniqueClicks / audience) * 10_000) / 10_000 : null,
    };
  });
  const feature = parsed.data.groupBy;
  const arms = new Map<string, Map<string, number[]>>();
  if (feature) {
    for (const post of posts) {
      const arm = armOf(post, feature);
      if (arm === null) continue;
      const click = clicksByVariant.get(post.contentVariantId);
      const audience = post.metrics.reach ?? post.metrics.views;
      const clickRate =
        audience && click ? Math.round((click.uniqueClicks / audience) * 10_000) / 10_000 : null;
      const metrics = arms.get(arm) ?? new Map<string, number[]>();
      const values: Record<string, number | null | undefined> = { ...post.metrics, clickRate };
      // A metric the platform did not return is skipped, never averaged as zero.
      for (const [name, value] of Object.entries(values))
        if (typeof value === "number") metrics.set(name, [...(metrics.get(name) ?? []), value]);
      arms.set(arm, metrics);
    }
  }
  return {
    ok: true,
    value: {
      ...(feature
        ? {
            groupBy: feature,
            groups: [...arms.entries()].map(([arm, metrics]) => ({
              arm,
              metrics: Object.fromEntries(
                [...metrics.entries()].map(([name, values]) => [
                  name,
                  {
                    mean:
                      Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10_000) /
                      10_000,
                    n: values.length,
                  },
                ]),
              ),
            })),
          }
        : {}),
      posts: performancePosts,
      ...patternsWithData(summarizeCreativePatterns(performancePosts)),
    },
  };
};
