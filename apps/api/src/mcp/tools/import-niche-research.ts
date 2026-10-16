import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  createResearchSnapshot,
  type ResearchSnapshot,
} from "@money-maker/core/research/research-snapshot";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const observation = z
  .object({
    key: z.string().trim().min(1).max(200),
    value: z.string().trim().min(1).max(2000),
    sourceUrl: z.url(),
  })
  .strict();
export const importNicheResearchInputSchema = z
  .object({
    workspaceId: z.uuid(),
    provider: z.enum(["vidiq", "hook_layer", "mercado_livre", "manual"]),
    nicheId: z.string().trim().min(1).max(200).optional(),
    query: z.string().trim().min(1).max(500),
    locale: z.string().trim().min(2).max(20),
    observedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    observations: z.array(observation).min(1).max(200),
  })
  .strict();
/** Observation ids are what script claims cite as research_observation evidence. */
const citable = (snapshot: ResearchSnapshot) =>
  snapshot.observations.map((observation) => ({
    id: observation.id,
    key: observation.key,
    sourceUrl: observation.sourceUrl,
  }));

export const importNicheResearchTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = importNicheResearchInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.researchRepository || !deps.audit)
    throw new Error("Research dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  if (parsed.data.nicheId) {
    if (!deps.nicheRepository) throw new Error("Niche repository is not configured.");
    const niche = await deps.nicheRepository.findForWorkspace({
      workspaceId,
      nicheId: parsed.data.nicheId,
    });
    if (!niche) return { ok: false, error: "INVALID_ARGUMENTS" };
  }
  try {
    const snapshot = createResearchSnapshot({
      ...parsed.data,
      workspaceId,
      actorId,
      observedAt: new Date(parsed.data.observedAt),
      expiresAt: new Date(parsed.data.expiresAt),
    });
    const existing = await deps.researchRepository.findByHash({
      workspaceId,
      hash: snapshot.contentHash,
    });
    if (existing)
      return {
        ok: true,
        value: {
          snapshotId: existing.id,
          expiresAt: existing.expiresAt.toISOString(),
          deduplicated: true,
          observations: citable(existing),
        },
      };
    const stored = await deps.researchRepository.create(snapshot);
    await deps.audit.record({
      action: "research.snapshot.imported",
      workspaceId,
      actorUserId: actorId,
      targetType: "ResearchSnapshot",
      targetId: stored.id,
      metadata: { provider: stored.provider, contentHash: stored.contentHash },
    });
    return {
      ok: true,
      value: {
        snapshotId: stored.id,
        expiresAt: stored.expiresAt.toISOString(),
        deduplicated: false,
        observations: citable(stored),
      },
    };
  } catch {
    return { ok: false, error: "INVALID_ARGUMENTS" };
  }
};
