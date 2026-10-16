import type { WorkspaceId } from "@money-maker/contracts";
import type { UsageEvent } from "./usage-event.js";

export interface UsageRepository {
  record(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void>;
  sum(input: {
    workspaceId: WorkspaceId;
    provider: UsageEvent["provider"];
    unit: UsageEvent["unit"];
    since: Date;
  }): Promise<number>;
}
