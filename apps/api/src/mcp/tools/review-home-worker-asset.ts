import type { UserId } from "@money-maker/contracts";
import { COMMERCIAL_USE_BY_PROVIDER } from "@money-maker/core/assets/asset";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const reviewHomeWorkerAssetInputSchema = z
  .object({
    workspaceId: z.uuid(),
    assetId: z.string().min(1).max(200),
    decision: z.enum(["approve", "reject"]),
  })
  .strict();

/**
 * A home worker image is held in pending_review because the server cannot prove which model
 * made it (ADR 0012). Approving makes it a normal banked asset, with commercial rights only when
 * its declared generator is allowlisted; rejecting archives it.
 */
export const reviewHomeWorkerAssetTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = reviewHomeWorkerAssetInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const repository = deps.assetRepository;
  if (!repository?.updateRights || !repository.updateMetadata)
    throw new Error("Asset review repository is not configured.");
  const asset = await repository.findForWorkspace({ workspaceId, assetId: parsed.data.assetId });
  if (!asset) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const provenance = asset.metadata?.homeWorker;
  if (asset.state !== "pending_review" || typeof provenance !== "object" || provenance === null)
    return { ok: false, error: "INVALID_CONTENT" };
  const approve = parsed.data.decision === "approve";
  await repository.updateMetadata({
    workspaceId,
    assetId: asset.id,
    patch: {
      homeWorker: {
        ...provenance,
        status: approve ? "approved" : "rejected",
        reviewedBy: actorId,
        reviewedAt: new Date().toISOString(),
      },
    },
  });
  if (approve)
    await repository.updateRights({
      workspaceId,
      assetId: asset.id,
      commercialUse: COMMERCIAL_USE_BY_PROVIDER.has(asset.creator ?? "") ? true : null,
      license: asset.license,
    });
  // State last: the asset is never usable before its review and rights are recorded.
  const updated = await repository.updateState({
    workspaceId,
    assetId: asset.id,
    state: approve ? "active" : "archived",
  });
  if (!updated) return { ok: false, error: "CONTENT_NOT_FOUND" };
  await deps.audit?.record({
    action: "home_worker.asset.reviewed",
    workspaceId,
    actorUserId: actorId,
    targetType: "Asset",
    targetId: asset.id,
    metadata: { decision: parsed.data.decision },
  });
  return {
    ok: true,
    value: { assetId: updated.id, state: updated.state, commercialUse: updated.commercialUse },
  };
};
