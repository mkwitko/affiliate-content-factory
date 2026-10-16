import type { UsageRepository } from "@money-maker/core/usage/usage-repository";
import type { UsageEvent } from "@money-maker/core/usage/usage-event";
import type { DatabaseClient } from "./client.js";

export class PrismaUsageRepository implements UsageRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async record(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void> {
    await this.client.usageEvent.create({
      data: {
        workspaceId: event.workspaceId,
        provider: event.provider,
        unit: event.unit,
        quantity: event.quantity,
        operation: event.operation,
        correlationId: event.correlationId ?? null,
      },
    });
  }

  public async sum(input: {
    workspaceId: UsageEvent["workspaceId"];
    provider: UsageEvent["provider"];
    unit: UsageEvent["unit"];
    since: Date;
  }): Promise<number> {
    const result = await this.client.usageEvent.aggregate({
      where: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        unit: input.unit,
        createdAt: { gte: input.since },
      },
      _sum: { quantity: true },
    });
    return result._sum.quantity ?? 0;
  }
}
