import type { UserId } from "@money-maker/contracts";
import type { YouTubeVideoSearchInput } from "@money-maker/core/research/youtube-discovery";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const searchYouTubeSourcesInputSchema = z
  .object({
    workspaceId: z.uuid(),
    query: z.string().trim().min(2).max(120),
    regionCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    relevanceLanguage: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
    publishedAfter: z.iso.datetime({ offset: true }).optional(),
    publishedBefore: z.iso.datetime({ offset: true }).optional(),
    order: z.enum(["relevance", "date", "viewCount"]).optional(),
    license: z.enum(["any", "creativeCommon"]).optional(),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.publishedAfter &&
      value.publishedBefore &&
      Date.parse(value.publishedAfter) > Date.parse(value.publishedBefore)
    )
      context.addIssue({
        code: "custom",
        message: "publishedAfter must be before publishedBefore",
      });
  });

export const searchYouTubeSourcesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = searchYouTubeSourcesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  if (!deps.youtubeSourceDiscovery) return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  try {
    const search: YouTubeVideoSearchInput = {
      query: parsed.data.query,
      limit: parsed.data.limit,
      ...(parsed.data.regionCode ? { regionCode: parsed.data.regionCode } : {}),
      ...(parsed.data.relevanceLanguage
        ? { relevanceLanguage: parsed.data.relevanceLanguage }
        : {}),
      ...(parsed.data.publishedAfter ? { publishedAfter: parsed.data.publishedAfter } : {}),
      ...(parsed.data.publishedBefore ? { publishedBefore: parsed.data.publishedBefore } : {}),
      ...(parsed.data.order ? { order: parsed.data.order } : {}),
      ...(parsed.data.license ? { license: parsed.data.license } : {}),
    };
    const videos = await deps.youtubeSourceDiscovery.searchVideos(search);
    return {
      ok: true,
      value: {
        observedAt: new Date().toISOString(),
        query: parsed.data.query,
        persisted: false,
        rightsNotice:
          "A Creative Commons label is a discovery signal, not permission to ingest or publish this media.",
        videos,
      },
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
