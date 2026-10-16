import type { WorkspaceId } from "@money-maker/contracts";
import type { Storyboard } from "./storyboard.js";

export interface StoryboardRepository {
  create(storyboard: Storyboard): Promise<Storyboard>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    storyboardId: string;
  }): Promise<Storyboard | null>;
  findLatestForScript(input: {
    workspaceId: WorkspaceId;
    scriptId: string;
  }): Promise<Storyboard | null>;
}
