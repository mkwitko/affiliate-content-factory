import type { UserId } from "@money-maker/contracts";
import {
  RELEVANT_FACT_LIMIT,
  checkNewFacts,
  relevantFacts,
} from "@money-maker/core/story/continuity";
import type { ContinuityFact } from "@money-maker/core/story/story";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { continuityFactSchema } from "./episode-plan.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const listContinuityFactsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    seriesId: z.string().trim().min(1).max(120),
    castIds: z.array(z.string().trim().min(1).max(80)).min(1).max(6),
    currentEpisode: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const recordContinuityFactsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    seriesId: z.string().trim().min(1).max(120),
    facts: z.array(continuityFactSchema).min(1).max(50),
  })
  .strict();

export const listContinuityFactsTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listContinuityFactsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.continuityRepository) throw new Error("Continuity repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const facts = await deps.continuityRepository.listForSeries({
    workspaceId,
    seriesId: parsed.data.seriesId,
  });
  return {
    ok: true,
    value: {
      facts: relevantFacts({
        facts,
        castIds: parsed.data.castIds,
        limit: parsed.data.limit ?? RELEVANT_FACT_LIMIT,
        ...(parsed.data.currentEpisode !== undefined
          ? { currentEpisode: parsed.data.currentEpisode }
          : {}),
      }),
    },
  };
};

export const recordContinuityFactsTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordContinuityFactsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.continuityRepository) throw new Error("Continuity repository is not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const incoming = parsed.data.facts as readonly ContinuityFact[];
  const existing = await deps.continuityRepository.listForSeries({
    workspaceId,
    seriesId: parsed.data.seriesId,
  });
  const violation = checkNewFacts(existing, incoming)[0];
  if (violation) return { ok: false, error: `CONTINUITY_REJECTED:${violation}` };
  try {
    // ponytail: check-then-append is not serialised; concurrent writers to one series could both
    // pass the exclusivity check. Add a per-series advisory lock if parallel episodes appear.
    await deps.continuityRepository.append({
      workspaceId,
      seriesId: parsed.data.seriesId,
      facts: incoming,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "CONTINUITY_FACT_CONFLICT")
      return { ok: false, error: "CONTINUITY_REJECTED:duplicate_fact" };
    throw error;
  }
  await deps.audit?.record({
    action: "story.continuity.recorded",
    workspaceId,
    actorUserId: actorId,
    targetType: "ContinuitySeries",
    targetId: parsed.data.seriesId,
    metadata: { count: incoming.length },
  });
  return { ok: true, value: { recorded: incoming.length } };
};
