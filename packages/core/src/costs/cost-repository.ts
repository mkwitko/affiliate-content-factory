import type { WorkspaceId } from "@money-maker/contracts";
import type { CostEvent } from "./cost-event.js";
export interface CostRepository {
  create(event: CostEvent): Promise<CostEvent>;
  settle(input: {
    workspaceId: WorkspaceId;
    id: string;
    actualMinor?: number;
  }): Promise<CostEvent | null>;
}
