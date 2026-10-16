import type { UserId } from "@money-maker/contracts";
import { COMMERCIAL_USE_BY_PROVIDER } from "@money-maker/core/assets/asset";
import { STAGE_ARTIFACT_ROLE } from "@money-maker/core/assets/stage-cache";
import { dependentAssetIds } from "@money-maker/core/assets/asset-rights";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const setAssetRightsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    assetId: z.string().min(1).max(200),
    commercialUse: z.union([z.boolean(), z.null()]),
    license: z.string().trim().min(1).max(500),
    sourceUrl: z.url().nullable().optional(),
    creator: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

export const setAssetRightsTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = setAssetRightsInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const repository = deps.assetRepository;
  if (!repository?.updateRights) throw new Error("Asset rights repository is not configured.");
  const asset = await repository.findForWorkspace({ workspaceId, assetId: parsed.data.assetId });
  if (!asset) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (asset.provenance === "rendered") return { ok: false, error: "INVALID_CONTENT" };
  // Stage-cached artifacts (Agnes scene clips) are cleared only by the G0 model allowlist.
  if (asset.metadata?.["role"] === STAGE_ARTIFACT_ROLE)
    return { ok: false, error: "INVALID_CONTENT" };
  if (
    asset.provenance === "stock" &&
    (parsed.data.commercialUse === null ||
      !parsed.data.sourceUrl ||
      !(parsed.data.creator ?? asset.creator))
  )
    return { ok: false, error: "INVALID_CONTENT" };
  if (
    asset.provenance === "operator_upload" &&
    parsed.data.commercialUse === true &&
    !/^(owned|licensed:.+)$/i.test(parsed.data.license.trim())
  )
    return { ok: false, error: "INVALID_CONTENT" };
  if (
    asset.provenance === "generated" &&
    parsed.data.commercialUse === true &&
    !COMMERCIAL_USE_BY_PROVIDER.has(asset.creator ?? "")
  )
    return { ok: false, error: "INVALID_CONTENT" };
  const updated = await repository.updateRights({
    workspaceId,
    assetId: asset.id,
    commercialUse: parsed.data.commercialUse,
    license: parsed.data.license,
    ...(parsed.data.sourceUrl !== undefined ? { sourceUrl: parsed.data.sourceUrl } : {}),
    ...(parsed.data.creator !== undefined && asset.provenance !== "generated"
      ? { creator: parsed.data.creator }
      : {}),
  });
  if (!updated) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const workspaceAssets = (await repository.listForWorkspace?.(workspaceId)) ?? [asset];
  const affectedAssetIds = dependentAssetIds(asset.id, workspaceAssets);
  await deps.contentRepository?.invalidateApprovalsForAssets?.({
    workspaceId,
    assetIds: affectedAssetIds,
  });
  await deps.audit?.record({
    action: "asset.rights.set",
    workspaceId,
    actorUserId: actorId,
    targetType: "Asset",
    targetId: asset.id,
    metadata: { commercialUse: parsed.data.commercialUse },
  });
  return { ok: true, value: { assetId: updated.id, commercialUse: updated.commercialUse } };
};
