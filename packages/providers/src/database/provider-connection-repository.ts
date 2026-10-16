import { parseWorkspaceId } from "@money-maker/contracts";
import { Prisma } from "../../generated/prisma/client.js";
import type {
  CreateProviderConnectionResult,
  ProviderConnection,
  ProviderConnectionRepository,
} from "@money-maker/core/providers/provider-connection-repository";
import type { DatabaseClient } from "./client.js";

const PROVIDER_TO_DOMAIN = {
  POST_FOR_ME: "post_for_me",
  MERCADO_LIVRE: "mercado_livre",
  CANVA: "canva",
  MODAL: "modal",
  VERCEL_AI_GATEWAY: "vercel_ai_gateway",
} as const satisfies Record<string, ProviderConnection["provider"]>;
type DatabaseProvider = keyof typeof PROVIDER_TO_DOMAIN;

const providerToDatabase = (provider: ProviderConnection["provider"]): DatabaseProvider => {
  const found = (Object.keys(PROVIDER_TO_DOMAIN) as DatabaseProvider[]).find(
    (key) => PROVIDER_TO_DOMAIN[key] === provider,
  );
  if (!found) throw new Error("Unsupported provider.");
  return found;
};

const modeToDatabase = (mode: ProviderConnection["mode"]): "API_KEY" | "OAUTH" =>
  mode === "api_key" ? "API_KEY" : "OAUTH";

const statusToDomain = (status: "ACTIVE" | "REVOKED" | "UNHEALTHY"): ProviderConnection["status"] =>
  status.toLowerCase() as ProviderConnection["status"];

const toDomain = (record: {
  id: string;
  workspaceId: string;
  provider: DatabaseProvider;
  mode: "API_KEY" | "OAUTH";
  status: "ACTIVE" | "REVOKED" | "UNHEALTHY";
  secretReference: string;
  accountId: string;
  platform: string | null;
  displayName: string | null;
  webhookId: string | null;
  webhookSecretReference: string | null;
}): ProviderConnection => ({
  id: record.id,
  workspaceId: parseWorkspaceId(record.workspaceId),
  provider: PROVIDER_TO_DOMAIN[record.provider],
  mode: record.mode === "API_KEY" ? "api_key" : "oauth",
  status: statusToDomain(record.status),
  secretReference: record.secretReference,
  accountId: record.accountId,
  ...(record.platform ? { platform: record.platform } : {}),
  ...(record.displayName ? { displayName: record.displayName } : {}),
  ...(record.webhookId ? { webhookId: record.webhookId } : {}),
  ...(record.webhookSecretReference
    ? { webhookSecretReference: record.webhookSecretReference }
    : {}),
});

export class PrismaProviderConnectionRepository implements ProviderConnectionRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async create(connection: ProviderConnection): Promise<CreateProviderConnectionResult> {
    try {
      const record = await this.client.providerConnection.create({
        data: {
          id: connection.id,
          workspaceId: connection.workspaceId,
          provider: providerToDatabase(connection.provider),
          mode: modeToDatabase(connection.mode),
          status: connection.status.toUpperCase() as "ACTIVE" | "REVOKED" | "UNHEALTHY",
          secretReference: connection.secretReference,
          accountId: connection.accountId,
          platform: connection.platform ?? null,
          displayName: connection.displayName ?? null,
          webhookId: connection.webhookId ?? null,
          webhookSecretReference: connection.webhookSecretReference ?? null,
        },
      });
      return { ok: true, connection: toDomain(record) };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return { ok: false, code: "duplicate_account" };
      }
      throw error;
    }
  }

  public async findAllForWorkspace(input: {
    workspaceId: ProviderConnection["workspaceId"];
  }): Promise<readonly ProviderConnection[]> {
    const records = await this.client.providerConnection.findMany({
      where: { workspaceId: input.workspaceId },
      orderBy: { createdAt: "asc" },
    });
    return records.map(toDomain);
  }

  public async findForWorkspace(input: {
    workspaceId: ProviderConnection["workspaceId"];
    connectionId: string;
  }): Promise<ProviderConnection | null> {
    const record = await this.client.providerConnection.findFirst({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record) : null;
  }

  public async findById(connectionId: string): Promise<ProviderConnection | null> {
    const record = await this.client.providerConnection.findUnique({ where: { id: connectionId } });
    return record ? toDomain(record) : null;
  }

  public async revoke(input: {
    workspaceId: ProviderConnection["workspaceId"];
    connectionId: string;
  }): Promise<void> {
    await this.client.providerConnection.updateMany({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
      data: { status: "REVOKED" },
    });
  }

  public async reactivate(input: {
    workspaceId: ProviderConnection["workspaceId"];
    connectionId: string;
    secretReference: string;
  }): Promise<ProviderConnection | null> {
    const result = await this.client.providerConnection.updateMany({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
      data: { status: "ACTIVE", secretReference: input.secretReference },
    });
    if (result.count !== 1) return null;
    return this.findForWorkspace({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    });
  }

  public async configureWebhook(input: {
    workspaceId: ProviderConnection["workspaceId"];
    connectionId: string;
    webhookId: string;
    webhookSecretReference: string;
  }): Promise<ProviderConnection | null> {
    const result = await this.client.providerConnection.updateMany({
      where: { id: input.connectionId, workspaceId: input.workspaceId },
      data: {
        webhookId: input.webhookId,
        webhookSecretReference: input.webhookSecretReference,
      },
    });
    if (result.count !== 1) return null;
    return this.findForWorkspace({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
    });
  }
}
