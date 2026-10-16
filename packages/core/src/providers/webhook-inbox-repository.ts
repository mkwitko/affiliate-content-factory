import type { WorkspaceId } from "@money-maker/contracts";

export type WebhookInboxInput = Readonly<{
  deliveryKey: string;
  workspaceId: WorkspaceId;
  connectionId: string;
  eventType: string;
  providerResourceId: string;
}>;

export type WebhookInboxInsertResult = Readonly<{ created: boolean }>;

export interface WebhookInboxRepository {
  createIfAbsent(input: WebhookInboxInput): Promise<WebhookInboxInsertResult>;
}
