import { createHash } from "node:crypto";
import type { UserId } from "@money-maker/contracts";
import { createAsset } from "@money-maker/core/assets/asset";
import { isSceneSpecStoryboard } from "@money-maker/core/content/storyboard";
import { composeSceneSvg } from "@money-maker/core/explainer/compose-scene";
import {
  readExplainerContext,
  scenePaletteFor,
} from "@money-maker/core/explainer/explainer-context";
import { geometryFor } from "@money-maker/core/explainer/layout";
import { estimateNarrationSeconds } from "@money-maker/core/explainer/script-guards";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { publicAssetUrl } from "./import-asset-from-url.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const STICKMAN_STILL_CREATOR = "money-maker:stickman-still-v1";
const PREVIEW_ROLE = "scene_preview";

export const previewVideoStoryboardInputSchema = z
  .object({ workspaceId: z.uuid(), storyboardId: z.string().min(1).max(200) })
  .strict();

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Composes every SceneSpec of a stickman_still storyboard into a 1080x1920 PNG, stores each as
 * an asset keyed by the hash of its SVG (an unchanged scene is never re-rasterized) and returns
 * links the operator can open before paying for narration and render.
 */
export const previewVideoStoryboardTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = previewVideoStoryboardInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  const {
    storyboardRepository,
    editorialRepository,
    contentRepository,
    nicheRepository,
    assetRepository,
    assetStore,
    sceneRasterizer,
  } = deps;
  if (
    !workspaceId ||
    !storyboardRepository ||
    !editorialRepository ||
    !contentRepository ||
    !nicheRepository ||
    !assetRepository ||
    !assetStore ||
    !sceneRasterizer
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const board = await storyboardRepository.findForWorkspace({
    workspaceId,
    storyboardId: parsed.data.storyboardId,
  });
  if (!board) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (!isSceneSpecStoryboard(board)) return { ok: false, error: "NICHE_KIND_MISMATCH" };
  const script = await editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: board.scriptId,
  });
  const item = await contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: board.contentItemId,
  });
  const niche = item
    ? await nicheRepository.findForWorkspace({ workspaceId, nicheId: item.nicheId })
    : null;
  const explainer = niche ? readExplainerContext(niche) : null;
  if (!script || !niche || !explainer) return { ok: false, error: "NICHE_KIND_MISMATCH" };
  const context = {
    characters: explainer.characters,
    palette: scenePaletteFor(niche),
    canvas: board.canvas,
  };
  const { frame } = geometryFor(board.canvas);

  const scenes = [];
  for (const scene of board.scenes) {
    let svg: string;
    try {
      svg = composeSceneSvg(scene, context);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("scene_character_missing:"))
        return { ok: false, error: `STORYBOARD_SCENE_INVALID:${scene.index}:character_missing` };
      throw error;
    }
    const svgChecksum = sha256(svg);
    const existing = await assetRepository.findByMetadata({
      workspaceId,
      role: PREVIEW_ROLE,
      key: "svgChecksum",
      value: svgChecksum,
    });
    let assetId = existing?.id;
    if (!assetId) {
      const png = await sceneRasterizer(svg, frame);
      const created = createAsset({
        workspaceId,
        mimeType: "image/png",
        checksum: sha256(png),
        byteSize: png.byteLength,
        width: frame.width,
        height: frame.height,
        provenance: "generated",
        creator: STICKMAN_STILL_CREATOR,
        license: "Rendered from SceneSpec",
        commercialUse: true,
        metadata: {
          role: PREVIEW_ROLE,
          storyboardId: board.id,
          sceneIndex: scene.index,
          svgChecksum,
          nicheId: niche.id,
        },
      });
      if (!created.ok) return { ok: false, error: "INVALID_CONTENT" };
      await assetStore.putObject({
        workspaceId,
        assetId: created.asset.id,
        mimeType: "image/png",
        checksum: created.asset.checksum,
        width: frame.width,
        height: frame.height,
        bytes: png,
      });
      const stored = await assetRepository.create(created.asset);
      await assetRepository.updateState({ workspaceId, assetId: stored.id, state: "active" });
      assetId = stored.id;
    }
    scenes.push({
      index: scene.index,
      purpose: scene.purpose,
      narration: script.body.slice(scene.fromChar, scene.toChar),
      assetId,
      url: publicAssetUrl(deps.publicApiUrl, workspaceId, assetId) ?? null,
    });
  }
  return {
    ok: true,
    value: {
      storyboardId: board.id,
      renderer: board.renderer,
      estimatedSeconds: estimateNarrationSeconds(script.body, script.language),
      hookFrameAssetId: scenes[0]?.assetId ?? null,
      scenes,
    },
  };
};
