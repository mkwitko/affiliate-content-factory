import { parseWorkspaceId } from "@money-maker/contracts";
import type { CostRepository } from "@money-maker/core/costs/cost-repository";
import type { CostEvent } from "@money-maker/core/costs/cost-event";
import type { DatabaseClient } from "./client.js";
export class PrismaCostRepository implements CostRepository {
  public constructor(private readonly client: DatabaseClient) {}
  public async create(event: CostEvent): Promise<CostEvent> {
    const record = await this.client.costEvent.create({
      data: {
        id: event.id,
        workspaceId: event.workspaceId,
        provider: event.provider,
        operation: event.operation,
        estimatedMinor: event.estimatedMinor,
        actualMinor: event.actualMinor ?? null,
        currency: event.currency,
        status: event.status,
      },
    });
    return { ...event, workspaceId: parseWorkspaceId(record.workspaceId) };
  }
  public async settle(input: {
    workspaceId: CostEvent["workspaceId"];
    id: string;
    actualMinor?: number;
  }): Promise<CostEvent | null> {
    const record = await this.client.costEvent.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId },
      data: {
        actualMinor: input.actualMinor ?? null,
        status: input.actualMinor === undefined ? "unresolved" : "settled",
      },
    });
    return record.count ? null : null;
  }
}
