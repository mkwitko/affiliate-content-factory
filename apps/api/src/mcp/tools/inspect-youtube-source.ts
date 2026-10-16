import type { UserId } from "@money-maker/contracts";
import {
  parseYouTubeSourceCollection,
  parseYouTubeVideoId,
  type YouTubeSourceVideo,
} from "@money-maker/core/research/youtube-discovery";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const inspectYouTubeSourceInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceUrl: z.url().trim().max(2000),
    limit: z.number().int().min(1).max(10).default(10),
  })
  .strict();

export const inspectYouTubeSourceTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = inspectYouTubeSourceInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const videoId = parseYouTubeVideoId(parsed.data.sourceUrl);
  const sourceCollection = videoId ? null : parseYouTubeSourceCollection(parsed.data.sourceUrl);
  if (!videoId && !sourceCollection) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const discovery = deps.youtubeSourceDiscovery;
  if (!discovery) return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  if (videoId && !discovery.getVideo) return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  if (sourceCollection && !discovery?.getCollection)
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };

  try {
    if (sourceCollection) {
      const collection = await discovery.getCollection({
        ...sourceCollection,
        limit: parsed.data.limit,
      });
      if (!collection) return { ok: false, error: "SOURCE_NOT_FOUND" };
      return {
        ok: true,
        value: {
          observedAt: new Date().toISOString(),
          persisted: false,
          collection,
          transcriptAvailable: false,
          mediaAvailable: false,
          rightsNotice:
            "Collection metadata and Creative Commons labels do not provide transcript/media access or permission to use any listed video.",
          nextRoutes: [
            "Choose a listed video and provide its transcript or subtitles for moment analysis.",
            "Use a useful topic as research and make an original short with independently verified facts.",
          ],
        },
      };
    }
    const video: YouTubeSourceVideo | null = await discovery.getVideo(videoId as string);
    if (!video) return { ok: false, error: "SOURCE_NOT_FOUND" };
    return {
      ok: true,
      value: {
        observedAt: new Date().toISOString(),
        persisted: false,
        video,
        transcriptAvailable: false,
        mediaAvailable: false,
        rightsNotice:
          "Public metadata and a captions-available flag do not provide transcript/media access or permission to use the source.",
        nextRoutes: [
          "Provide transcript text or subtitles for moment analysis.",
          "Use this source as research and make an original short with independently verified facts.",
        ],
      },
    };
  } catch {
    return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  }
};
