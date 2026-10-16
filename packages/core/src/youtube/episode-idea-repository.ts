import type { WorkspaceId } from "@money-maker/contracts";
import type { EpisodeIdea, EpisodeIdeaStatus } from "./episode-idea.js";

/** Every method is scoped by `workspaceId`; an idea of another workspace is simply not found. */
export interface EpisodeIdeaRepository {
  createMany(ideas: readonly EpisodeIdea[]): Promise<void>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    ideaId: string;
  }): Promise<EpisodeIdea | null>;
  /** Newest first. */
  listForNiche(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    status?: EpisodeIdeaStatus;
  }): Promise<readonly EpisodeIdea[]>;
  /** Replaces the stored state of an existing idea. Returns false when it does not exist. */
  save(idea: EpisodeIdea): Promise<boolean>;
}
