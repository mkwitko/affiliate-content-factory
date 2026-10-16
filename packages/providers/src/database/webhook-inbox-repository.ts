import { Prisma } from "../../generated/prisma/client.js";
import type { WebhookInboxRepository } from "@money-maker/core/providers/webhook-inbox-repository";
import type { DatabaseClient } from "./client.js";

export class PrismaWebhookInboxRepository implements WebhookInboxRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createIfAbsent(input: Parameters<WebhookInboxRepository["createIfAbsent"]>[0]) {
    try {
      const connection = await this.client.providerConnection.findFirst({
        where: { id: input.connectionId, workspaceId: input.workspaceId },
        select: { id: true },
      });
      if (!connection) throw new Error("webhook_connection_not_found");
      await this.client.webhookInbox.create({
        data: {
          deliveryKey: input.deliveryKey,
          workspaceId: input.workspaceId,
          connectionId: input.connectionId,
          eventType: input.eventType,
          providerResourceId: input.providerResourceId,
        },
      });
      return { created: true } as const;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { created: false } as const;
      }
      throw error;
    }
  }
}
