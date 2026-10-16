import type { WorkspaceId } from "@money-maker/contracts";
import type { Niche } from "./niche.js";

export interface NicheRepository {
  create(niche: Niche): Promise<Niche>;
  listForWorkspace?(workspaceId: WorkspaceId): Promise<readonly Niche[]>;
  findForWorkspace(input: { workspaceId: WorkspaceId; nicheId: string }): Promise<Niche | null>;
  updateState(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    state: Niche["state"];
  }): Promise<Niche | null>;
  update?(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    name?: string;
    audience?: string;
    problem?: string;
    editorialVoice?: string;
    languages?: readonly string[];
    monetizationHypothesis?: string;
  }): Promise<Niche | null>;
  updateContext?(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    context: Record<string, unknown>;
  }): Promise<Niche | null>;
}
