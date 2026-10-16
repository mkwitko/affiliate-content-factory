import type { WorkspaceId } from "@money-maker/contracts";
import type { ResearchSnapshot } from "./research-snapshot.js";
export interface ResearchRepository {
  create(snapshot: ResearchSnapshot): Promise<ResearchSnapshot>;
  findByHash(input: { workspaceId: WorkspaceId; hash: string }): Promise<ResearchSnapshot | null>;
  findActiveForNiche?(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    now: Date;
  }): Promise<readonly ResearchSnapshot[]>;
  listForWorkspace?(workspaceId: WorkspaceId): Promise<readonly ResearchSnapshot[]>;
  findObservationForWorkspace?(input: {
    workspaceId: WorkspaceId;
    observationId: string;
  }): Promise<Readonly<{
    id: string;
    snapshotId: string;
    key: string;
    value: string;
    sourceUrl: string;
    expiresAt: Date;
  }> | null>;
}
