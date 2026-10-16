import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId, type WorkspaceId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

export const createProviderConnectionInputSchema = z
  .object({
    workspaceId: z.uuid(),
    apiKey: z.string().trim().min(1).max(4096),
    instagramHandle: z.string().trim().min(1).max(200),
  })
  .strict()
  .describe("Create a workspace-owned Post For Me API-key connection.");

/** Strips a leading "@" and normalizes case so a submitted handle matches the provider's username. */
const normalizeHandle = (value: string): string => value.trim().replace(/^@/, "").toLowerCase();

export const publicProviderConnection = (connection: ProviderConnection) => ({
  id: connection.id,
  workspaceId: connection.workspaceId,
  provider: connection.provider,
  mode: connection.mode,
  status: connection.status,
  accountId: connection.accountId,
  displayName: connection.displayName ?? null,
});

export const providerDependencies = (dependencies: McpDependencies, workspaceId: WorkspaceId) => {
  const secretStore =
    dependencies.secretStoreForWorkspace?.(workspaceId) ?? dependencies.secretStore;
  if (!dependencies.providerConnections || !secretStore) {
    throw new Error("Provider connection dependencies are not configured.");
  }
  return { connections: dependencies.providerConnections, secrets: secretStore };
};

export const authorizeProviderWorkspace = async (
  dependencies: McpDependencies,
  actorId: UserId,
  workspaceId: WorkspaceId,
  allowedRoles: readonly ("owner" | "operator" | "reviewer")[],
): Promise<ToolResult | null> => {
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles,
  });
  return authorization.ok ? null : { ok: false, error: "FORBIDDEN" };
};

export const createProviderConnectionTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createProviderConnectionInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };

  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = await authorizeProviderWorkspace(dependencies, actorId, workspaceId, [
    "owner",
    "operator",
  ]);
  if (authorization) return authorization;

  if (!dependencies.postForMeClient) throw new Error("Post For Me client is not configured.");
  const { connections, secrets } = providerDependencies(dependencies, workspaceId);

  let accounts: Awaited<
    ReturnType<NonNullable<typeof dependencies.postForMeClient>["listSocialAccounts"]>
  >;
  try {
    accounts = await dependencies.postForMeClient.listSocialAccounts(parsed.data.apiKey);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_api_key")
      return { ok: false, error: "INVALID_API_KEY" };
    throw error;
  }
  const submittedHandle = normalizeHandle(parsed.data.instagramHandle);
  const match = accounts.find(
    (account) =>
      account.platform === "instagram" && normalizeHandle(account.username) === submittedHandle,
  );
  if (!match) return { ok: false, error: "ACCOUNT_NOT_FOUND" };

  const connection = createProviderConnection({
    id: randomUUID(),
    workspaceId,
    provider: "post_for_me",
    mode: "api_key",
    accountId: match.id,
    displayName: match.username,
    secretReference: `secret://workspace/${workspaceId}/provider-connection/${randomUUID()}`,
  });

  await secrets.put({ reference: connection.secretReference, secret: parsed.data.apiKey });
  try {
    const result = await connections.create(connection);
    if (!result.ok) {
      await secrets.delete(connection.secretReference);
      return { ok: false, error: "CONNECTION_ALREADY_EXISTS" };
    }
    return { ok: true, value: { connection: publicProviderConnection(result.connection) } };
  } catch (error) {
    await secrets.delete(connection.secretReference);
    throw error;
  }
};
