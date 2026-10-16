import type { WorkspaceId } from "@money-maker/contracts";

export type JobCount = Readonly<{
  name: string;
  status: string;
  count: number;
}>;
export type FailedJob = Readonly<{
  id: string;
  name: string;
  idempotencyKey: string;
  terminalReason: string | null;
  updatedAt: Date;
  attemptCount: number;
  /** Payload identifiers (contentItemId, offerId, ...), when the adapter reads them. */
  identifiers?: Readonly<Record<string, string>>;
}>;

/** Read-only queue statistics for status and attention lists. Workspace-scoped. */
export interface JobStats {
  countByStatus(input: {
    workspaceId: WorkspaceId;
    names?: readonly string[];
  }): Promise<readonly JobCount[]>;
  /** Terminally failed jobs updated at or after `since`, newest first. */
  listFailed(input: {
    workspaceId: WorkspaceId;
    since: Date;
    take: number;
  }): Promise<readonly FailedJob[]>;
}
