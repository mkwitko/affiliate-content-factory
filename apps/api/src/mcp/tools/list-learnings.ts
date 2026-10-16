import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { computeAllLearnings } from "@money-maker/core/analytics/learnings";
import { learningFeatures } from "@money-maker/core/content/content";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const listLearningsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    feature: z.enum(learningFeatures).optional(),
    platform: z.enum(["instagram", "youtube", "tiktok", "threads"]).optional(),
    checkpointDays: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]).default(7),
  })
  .strict();

export const listLearningsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listLearningsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.performanceRepository) throw new Error("Performance dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const rows = await deps.performanceRepository.observationsAtCheckpoint(workspaceId, {
    checkpointDays: parsed.data.checkpointDays,
  });
  const all = computeAllLearnings(rows, {
    checkpointDays: parsed.data.checkpointDays,
    ...(parsed.data.feature ? { feature: parsed.data.feature } : {}),
    ...(parsed.data.platform ? { platform: parsed.data.platform } : {}),
  });
  return {
    ok: true,
    value: {
      learnings: all.filter((entry) => entry.status === "learning"),
      insufficientData: all.filter((entry) => entry.status === "insufficient_data"),
      note: "Directional only: recomputed on every read, never stored. Needs at least 8 observations per arm.",
    },
  };
};
