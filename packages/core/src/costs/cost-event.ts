import type { WorkspaceId } from "@money-maker/contracts";
export type CostEvent = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  provider: string;
  operation: string;
  estimatedMinor: number;
  actualMinor?: number;
  currency: string;
  status: "reserved" | "settled" | "unresolved";
}>;
export const reserveCost = (input: Omit<CostEvent, "id" | "status">): CostEvent => {
  if (!Number.isInteger(input.estimatedMinor) || input.estimatedMinor < 0)
    throw new Error("invalid_cost");
  return Object.freeze({ ...input, id: crypto.randomUUID(), status: "reserved" as const });
};
