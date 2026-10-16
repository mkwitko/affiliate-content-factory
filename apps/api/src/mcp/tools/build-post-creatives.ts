import type { UserId } from "@money-maker/contracts";
import { buildPostCreatives } from "@money-maker/core/creatives/build-post-creatives";
import { SCENE_ASSET_ID_PATTERN, type SlideSpec } from "@money-maker/core/creatives/slide-spec";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const identifier = z.string().trim().min(1).max(200);
const slideSchema = z
  .object({
    index: z.number().int().positive(),
    total: z.number().int().min(5).max(7),
    template: z.enum(["hero", "benefit", "proof", "review", "price", "cta"]),
    headline: z.string().max(60),
    body: z.string().max(140).optional(),
    badge: z.string().max(40).optional(),
    sceneAssetId: z.string().regex(SCENE_ASSET_ID_PATTERN).optional(),
    claims: z
      .array(
        z
          .object({ text: z.string().trim().min(1).max(120), factKey: identifier.optional() })
          .strict(),
      )
      .max(10),
  })
  .strict();

export const buildPostCreativesInputSchema = z
  .object({
    workspaceId: z.uuid(),
    contentItemId: identifier,
    slides: z.array(slideSchema).min(5).max(7),
    channelIds: z.array(identifier).min(1).max(4),
  })
  .strict();

export const buildPostCreativesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = buildPostCreativesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.offerRepository || !deps.channelRepository || !deps.jobQueue)
    throw new Error("Creative build dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  // Pre-existing typecheck break on main (core returns string errors); cast until ToolError covers them.
  return (await buildPostCreatives(
    {
      contentRepository: deps.contentRepository,
      offerRepository: deps.offerRepository,
      channelRepository: deps.channelRepository,
      jobQueue: deps.jobQueue,
    },
    {
      workspaceId,
      contentItemId: parsed.data.contentItemId,
      slides: parsed.data.slides as readonly SlideSpec[],
      channelIds: parsed.data.channelIds,
    },
  )) as ToolResult;
};
