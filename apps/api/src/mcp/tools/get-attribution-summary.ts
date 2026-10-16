import type { UserId } from "@money-maker/contracts";
import { salesStatement } from "@money-maker/core/analytics/conversion-evidence";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const getAttributionSummaryInputSchema = z
  .object({
    workspaceId: z.uuid(),
    groupBy: z
      .enum(["publication", "variant", "contentItem", "niche", "channel"])
      .default("niche")
      .describe("What each row counts clicks for."),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const getAttributionSummaryTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getAttributionSummaryInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.attributionRepository) throw new Error("Attribution dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const rows = await deps.attributionRepository.summary(workspaceId, {
    groupBy: parsed.data.groupBy,
    ...(parsed.data.since ? { since: new Date(parsed.data.since) } : {}),
    ...(parsed.data.until ? { until: new Date(parsed.data.until) } : {}),
  });
  return {
    ok: true,
    value: {
      groupBy: parsed.data.groupBy,
      rows,
      // No unique total: one visitor can click several groups, so per-group uniques do not add up.
      totalClicks: rows.reduce((sum, row) => sum + row.clicks, 0),
      // Clicks are not sales: no sale evidence store exists yet, so the report says so plainly.
      sales: salesStatement([]),
    },
  };
};
