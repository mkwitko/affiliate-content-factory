import { createHash } from "node:crypto";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createAsset } from "@money-maker/core/assets/asset";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const createStoryAssetsInputSchema = z
  .object({
    workspaceId: z.uuid(),
    assetIds: z.array(z.string().trim().min(1).max(200)).min(1).max(10),
  })
  .strict()
  .describe(
    "Convert ordered carousel slide assets (4:5) into 1080x1920 Stories images: each slide is centered over a blurred, darkened copy of itself filling the frame, the same compositing render_reel uses, stored as new workspace assets in the same order. Use this instead of generating a separate Stories-sized slide batch, so Stories are never skipped for aspect ratio.",
  );

const maxSourceBytes = 15_000_000;
const sourceMimeTypes = ["image/jpeg", "image/png", "image/webp"];

export const createStoryAssetsTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createStoryAssetsInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.assetRepository || !deps.assetStore || !deps.storyImageComposer) {
    throw new Error("Story asset dependencies are not configured.");
  }
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;

  const assetIds: string[] = [];
  for (const sourceAssetId of parsed.data.assetIds) {
    const source = await deps.assetRepository.findForWorkspace({
      workspaceId,
      assetId: sourceAssetId,
    });
    if (source?.state !== "active") return { ok: false, error: "CONTENT_NOT_FOUND" };
    try {
      const target = await deps.assetStore.createDownload({ workspaceId, assetId: sourceAssetId });
      const media = await fetchSafeMedia(new URL(target.url), {
        maxBytes: maxSourceBytes,
        allowedMimeTypes: sourceMimeTypes,
      });
      const composed = await deps.storyImageComposer.compose({
        bytes: media.bytes,
        mimeType: media.mimeType,
        width: source.width,
        height: source.height,
      });
      const created = createAsset({
        workspaceId,
        mimeType: composed.mimeType,
        checksum: createHash("sha256").update(composed.bytes).digest("hex"),
        width: composed.width,
        height: composed.height,
        provenance: "generated",
        license: "Generated from carousel slide for Stories (9:16 composite)",
      });
      if (!created.ok) return { ok: false, error: "INVALID_CONTENT" };
      await deps.assetStore.putObject({
        workspaceId,
        assetId: created.asset.id,
        mimeType: created.asset.mimeType,
        checksum: created.asset.checksum,
        width: created.asset.width,
        height: created.asset.height,
        bytes: composed.bytes,
      });
      await deps.assetRepository.create(created.asset);
      await deps.assetRepository.updateState({
        workspaceId,
        assetId: created.asset.id,
        state: "active",
      });
      assetIds.push(created.asset.id);
    } catch {
      return { ok: false, error: "INVALID_CONTENT" };
    }
  }
  return { ok: true, value: { assetIds } };
};
