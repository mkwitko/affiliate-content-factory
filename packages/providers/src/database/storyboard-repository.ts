import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Storyboard } from "@money-maker/core/content/storyboard";
import type {
  SceneClipState,
  SceneClipStateRepository,
  SceneClipStates,
} from "@money-maker/core/content/scene-clip-state";
import type { StoryboardRepository } from "@money-maker/core/content/storyboard-repository";
import type { DatabaseClient } from "./client.js";

export const storyboardFromRow = (row: {
  id: string;
  workspaceId: string;
  contentItemId: string;
  scriptId: string;
  version: number;
  scenes: unknown;
  voiceId: string;
  musicTrackId: string | null;
  canvas: string;
  renderer: string;
  checksum: string;
  createdAt: Date;
  actorId: string;
}): Storyboard => ({
  id: row.id,
  workspaceId: parseWorkspaceId(row.workspaceId),
  contentItemId: row.contentItemId,
  scriptId: row.scriptId,
  version: row.version,
  scenes: row.scenes as Storyboard["scenes"],
  voiceId: row.voiceId,
  musicTrackId: row.musicTrackId,
  canvas: row.canvas as Storyboard["canvas"],
  // The CHECK constraint allows only these; anything else reads as the legacy renderer.
  renderer:
    row.renderer === "stickman_still" ||
    row.renderer === "stickman_motion" ||
    row.renderer === "ai_clips"
      ? row.renderer
      : "slideshow",
  checksum: row.checksum,
  createdAt: row.createdAt,
  actorId: parseUserId(row.actorId),
});
export class PrismaStoryboardRepository implements StoryboardRepository, SceneClipStateRepository {
  public constructor(private readonly client: DatabaseClient) {}
  public async create(storyboard: Storyboard): Promise<Storyboard> {
    try {
      const row = await this.client.videoStoryboard.create({
        data: { ...storyboard, scenes: [...storyboard.scenes] },
      });
      return storyboardFromRow(row);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new Error("STORYBOARD_VERSION_CONFLICT");
      throw error;
    }
  }
  public async findForWorkspace(input: {
    workspaceId: Storyboard["workspaceId"];
    storyboardId: string;
  }) {
    const row = await this.client.videoStoryboard.findFirst({
      where: { workspaceId: input.workspaceId, id: input.storyboardId },
    });
    return row ? storyboardFromRow(row) : null;
  }
  public async findLatestForScript(input: {
    workspaceId: Storyboard["workspaceId"];
    scriptId: string;
  }) {
    const row = await this.client.videoStoryboard.findFirst({
      where: { workspaceId: input.workspaceId, scriptId: input.scriptId },
      orderBy: { version: "desc" },
    });
    return row ? storyboardFromRow(row) : null;
  }
  public async read(input: {
    workspaceId: Storyboard["workspaceId"];
    storyboardId: string;
  }): Promise<SceneClipStates> {
    const row = await this.client.videoStoryboard.findFirst({
      where: { workspaceId: input.workspaceId, id: input.storyboardId },
      select: { clipState: true },
    });
    const state = row?.clipState;
    return typeof state === "object" && state !== null && !Array.isArray(state)
      ? (state as SceneClipStates)
      : {};
  }
  public async write(input: {
    workspaceId: Storyboard["workspaceId"];
    storyboardId: string;
    sceneIndex: number;
    state: SceneClipState;
  }): Promise<void> {
    // One jsonb_set keeps a concurrent write to another scene from being lost.
    await this.client.$executeRaw`
      UPDATE "video_storyboards"
      SET "clip_state" = jsonb_set("clip_state", ARRAY[${String(input.sceneIndex)}]::text[], ${JSON.stringify(input.state)}::jsonb, true)
      WHERE "id" = ${input.storyboardId} AND "workspace_id" = ${input.workspaceId}::uuid`;
  }
}
