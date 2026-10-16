import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const listRecentOwnedLongFormsInputSchema = z
  .object({ workspaceId: z.uuid(), limit: z.number().int().min(1).max(10).optional() })
  .strict();

export const listRecentOwnedLongFormsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listRecentOwnedLongFormsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.longFormRenderRepository) return { ok: false, error: "CONNECTION_UNAVAILABLE" };

  try {
    const recent = await deps.longFormRenderRepository.listRecentForWorkspace({
      workspaceId,
      limit: parsed.data.limit ?? 5,
    });
    const candidateCounts = await Promise.all(
      recent.map(async ({ render }) => {
        if (!render.assetId || !deps.assetRepository) return null;
        const stored = (
          await deps.assetRepository.findForWorkspace({ workspaceId, assetId: render.assetId })
        )?.metadata?.ownedClipCandidates as { candidates?: unknown[] } | undefined;
        return Array.isArray(stored?.candidates) ? stored.candidates.length : 0;
      }),
    );
    return {
      ok: true,
      value: {
        renders: recent.map(({ render, contentItemId, contentTitle }, index) => ({
          candidateCount: candidateCounts[index] ?? null,
          renderId: render.id,
          contentItemId,
          title: contentTitle,
          status: render.status,
          createdAt: render.createdAt.toISOString(),
          durationMs: render.durationMs ?? null,
          timingAvailable: render.status === "ready" && Boolean(render.timingManifest),
        })),
      },
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
