import type { WorkspaceId } from "@money-maker/contracts";
import type { ContentScript, EditorialReview } from "./editorial.js";

export interface EditorialRepository {
  createScript(script: ContentScript): Promise<ContentScript>;
  findScriptForWorkspace(input: {
    workspaceId: WorkspaceId;
    scriptId: string;
  }): Promise<ContentScript | null>;
  findScriptVersion(input: {
    workspaceId: WorkspaceId;
    contentItemId: string;
    version?: number;
  }): Promise<ContentScript | null>;
  nextScriptVersion(input: { workspaceId: WorkspaceId; contentItemId: string }): Promise<number>;
  approveDraft(input: {
    workspaceId: WorkspaceId;
    scriptId: string;
    checksum: string;
    actorId: ContentScript["actorId"];
    approvedAt: Date;
  }): Promise<ContentScript | null>;
  createReview(review: EditorialReview): Promise<EditorialReview>;
  findCurrentReview(input: {
    workspaceId: WorkspaceId;
    variantId: string;
  }): Promise<EditorialReview | null>;
}
