import type { UserId } from "@money-maker/contracts";
import type { ScenePlan } from "@money-maker/core/creatives/scene-plan";
import { hasGenericHookOpener } from "@money-maker/core/creatives/slide-spec";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const plan = z
  .object({
    role: z.enum(["hero", "secondary"]),
    productAnchor: z.enum(["left", "center", "right"]),
    surface: z.enum(["table", "shelf", "counter", "abstract"]),
    lighting: z.enum(["top-left", "top-right", "soft-front"]),
    nicheSetting: z.string().trim().min(1).max(120),
    paletteHint: z.string().trim().min(1).max(120),
  })
  .strict();
export const requestStoryboardScenesInputSchema = z
  .object({
    workspaceId: z.uuid(),
    scriptId: z.string().min(1).max(200),
    requests: z
      .array(z.object({ index: z.number().int().min(1).max(40), plan }).strict())
      .min(1)
      .max(40),
  })
  .strict();
export const requestStoryboardScenesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = requestStoryboardScenesInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.requestStoryboardScene ||
    !deps.editorialRepository ||
    !deps.contentRepository
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const script = await deps.editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: parsed.data.scriptId,
  });
  if (!script || script.status !== "approved") return { ok: false, error: "SCRIPT_NOT_APPROVED" };
  if (script.body && hasGenericHookOpener(script.body))
    return { ok: false, error: "CREATIVE_QUALITY_REJECTED:generic_hook" };
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: script.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const result = [];
  for (const request of parsed.data.requests) {
    const scene = await deps.requestStoryboardScene({
      workspaceId,
      nicheId: item.nicheId,
      plan: request.plan as ScenePlan,
      correlationId: script.id,
    });
    result.push({ index: request.index, assetId: scene.assetId, source: scene.source });
  }
  await deps.audit?.record({
    action: "content.storyboard.scenes_requested",
    workspaceId,
    actorUserId: actorId,
    targetType: "ContentScript",
    targetId: script.id,
    metadata: { count: result.length },
  });
  return { ok: true, value: { scenes: result } };
};
