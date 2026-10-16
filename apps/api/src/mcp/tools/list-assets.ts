import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const listAssetsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    /** pending_review lists home worker images waiting for review_home_worker_asset. */
    state: z.enum(["active", "pending_review"]).optional(),
  })
  .strict();
export const listAssetsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listAssetsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const repository = deps.assetRepository;
  if (!repository?.listForWorkspace)
    throw new Error("Repository list operation is not configured.");
  const state = parsed.data.state ?? "active";
  const assets = await repository.listForWorkspace(workspaceId, state);
  if (state === "active") return { ok: true, value: { assets } };
  // A reviewer has to see the image before deciding; the link expires like every download.
  const withPreview = await Promise.all(
    assets.map(async (asset) => ({
      ...asset,
      previewUrl: await deps.assetStore
        ?.createDownload({ workspaceId, assetId: asset.id })
        .then((target) => target.url)
        .catch(() => null),
    })),
  );
  return { ok: true, value: { assets: withPreview } };
};
