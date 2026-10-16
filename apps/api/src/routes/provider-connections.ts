import type { FastifyInstance } from "fastify";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createProviderConnection } from "@money-maker/core/providers/provider-connection";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string };
type ConnectionParams = { workspaceId: string; connectionId: string };

const createSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4096),
    accountId: z.string().trim().min(1).max(200),
    platform: z.enum(["instagram", "youtube"]).default("instagram"),
  })
  .strict();

const publicConnection = (connection: {
  id?: string;
  workspaceId: string;
  provider: string;
  mode: string;
  status: string;
  accountId: string;
  displayName?: string;
  platform?: string;
}) => ({
  id: connection.id,
  workspaceId: connection.workspaceId,
  provider: connection.provider,
  mode: connection.mode,
  status: connection.status,
  accountId: connection.accountId,
  displayName: connection.displayName ?? null,
  ...(connection.platform ? { platform: connection.platform } : {}),
});

/** Strips a leading "@" and normalizes case so a submitted handle matches the provider's username. */
const normalizeHandle = (value: string): string => value.trim().replace(/^@/, "").toLowerCase();

const workspace = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const requireDependencies = (
  dependencies: ApiDependencies,
  workspaceId: ReturnType<typeof parseWorkspaceId>,
) => {
  const secretStore =
    dependencies.secretStoreForWorkspace?.(workspaceId) ?? dependencies.secretStore;
  if (!dependencies.providerConnections || !secretStore) {
    throw new Error("Provider connection dependencies are not configured.");
  }
  return {
    connections: dependencies.providerConnections,
    secrets: secretStore,
  };
};

export const authorizeMember = async (
  dependencies: ApiDependencies,
  workspaceId: ReturnType<typeof parseWorkspaceId>,
  userId: UserId,
  allowedRoles: readonly ("owner" | "operator" | "reviewer")[],
) => {
  const member = await dependencies.workspaces.findByIdForMember({ workspaceId, userId });
  if (!member) return { ok: false as const, status: 404 as const };
  const authorization = authorizeWorkspace({
    actorId: userId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId }),
    allowedRoles,
  });
  return authorization.ok ? { ok: true as const } : { ok: false as const, status: 403 as const };
};

const connectionTestCooldownMs = 10_000;

export const registerProviderConnectionRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  // ponytail: in-process cooldown (single API instance); move to a shared store if the API scales out.
  const lastConnectionTest = new Map<string, number>();
  app.post<{ Params: Params; Body: unknown }>(
    "/v1/workspaces/:workspaceId/provider-connections/post-for-me",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      const body = createSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (!options.dependencies.postForMeClient) return unexpectedError(reply);
      try {
        const { connections, secrets } = requireDependencies(options.dependencies, workspaceId);
        let accounts: Awaited<
          ReturnType<NonNullable<ApiDependencies["postForMeClient"]>["listSocialAccounts"]>
        >;
        try {
          accounts = await options.dependencies.postForMeClient.listSocialAccounts(
            body.data.apiKey,
            body.data.platform,
          );
        } catch (error) {
          if (error instanceof Error && error.message === "invalid_api_key")
            return sendError(reply, 400, {
              code: "INVALID_API_KEY",
              message: "Post For Me rejected this API key",
            });
          return unexpectedError(reply);
        }
        const submittedHandle = normalizeHandle(body.data.accountId);
        const platformAccounts = accounts.filter(
          (account) => account.platform === body.data.platform,
        );
        const match = platformAccounts.find(
          (account) => normalizeHandle(account.username) === submittedHandle,
        );
        if (!match)
          return sendError(reply, 400, {
            code: "ACCOUNT_NOT_FOUND",
            message: `${body.data.platform} account not found for this API key`,
            details: { availableAccounts: platformAccounts.map((account) => account.username) },
          });

        const connection = createProviderConnection({
          id: randomUUID(),
          workspaceId,
          provider: "post_for_me",
          mode: "api_key",
          accountId: match.id,
          platform: match.platform,
          displayName: match.username,
          secretReference: `secret://workspace/${workspaceId}/provider-connection/${randomUUID()}`,
        });
        await secrets.put({ reference: connection.secretReference, secret: body.data.apiKey });
        try {
          const result = await connections.create(connection);
          if (!result.ok) {
            await secrets.delete(connection.secretReference);
            if (result.code === "duplicate_account")
              return sendError(reply, 409, {
                code: "CONNECTION_ALREADY_EXISTS",
                message: "Connection already exists",
              });
          }
          if (!result.ok) return unexpectedError(reply);
          return reply.code(201).send({ connection: publicConnection(result.connection) });
        } catch (error) {
          await secrets.delete(connection.secretReference);
          throw error;
        }
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.get<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/provider-connections",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (!workspaceId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      try {
        const { connections } = requireDependencies(options.dependencies, workspaceId);
        const records = await connections.findAllForWorkspace({ workspaceId });
        return reply.code(200).send({ connections: records.map(publicConnection) });
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.delete<{ Params: ConnectionParams }>(
    "/v1/workspaces/:workspaceId/provider-connections/:connectionId",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (!workspaceId || !request.params.connectionId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      try {
        const { connections, secrets } = requireDependencies(options.dependencies, workspaceId);
        const connection = await connections.findForWorkspace({
          workspaceId,
          connectionId: request.params.connectionId,
        });
        if (!connection)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Connection not found" });
        await connections.revoke({ workspaceId, connectionId: connection.id });
        await secrets.delete(connection.secretReference);
        return reply.code(204).send();
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: ConnectionParams }>(
    "/v1/workspaces/:workspaceId/provider-connections/:connectionId/test",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (!workspaceId || !request.params.connectionId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator", "reviewer"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      try {
        const { connections, secrets } = requireDependencies(options.dependencies, workspaceId);
        const connection = await connections.findForWorkspace({
          workspaceId,
          connectionId: request.params.connectionId,
        });
        if (!connection)
          return sendError(reply, 404, { code: "NOT_FOUND", message: "Connection not found" });
        const now = Date.now();
        if (now - (lastConnectionTest.get(connection.id) ?? 0) < connectionTestCooldownMs)
          return sendError(reply, 429, {
            code: "TOO_MANY_REQUESTS",
            message: "Wait a few seconds before testing this connection again",
          });
        lastConnectionTest.set(connection.id, now);
        const checkedAt = new Date().toISOString();
        const unavailable = (reason: string) =>
          reply.code(200).send({ ok: false, reason, checkedAt });

        if (connection.provider === "post_for_me") {
          if (!options.dependencies.postForMeClient) return unexpectedError(reply);
          const apiKey = await secrets.get(connection.secretReference);
          if (!apiKey) return unavailable("provider_unavailable");
          try {
            const accounts = await options.dependencies.postForMeClient.listSocialAccounts(apiKey);
            const match = accounts.find(
              (account) => account.id === connection.accountId && account.status === "active",
            );
            if (!match) return unavailable("account_missing");
            return reply.code(200).send({ ok: true, account: `@${match.username}`, checkedAt });
          } catch (error) {
            return unavailable(
              error instanceof Error && error.message === "invalid_api_key"
                ? "invalid_api_key"
                : "provider_unavailable",
            );
          }
        }

        if (connection.provider === "mercado_livre") {
          const mlClient = options.dependencies.mercadoLivreClientForWorkspace?.(workspaceId);
          if (!mlClient) return unavailable("provider_unavailable");
          try {
            const response = await mlClient.request("/users/me");
            if (response.status === 401 || response.status === 403)
              return unavailable("reconnect_required");
            if (response.status < 200 || response.status >= 300)
              return unavailable("provider_unavailable");
            const body = (await response.json()) as { nickname?: unknown };
            if (typeof body.nickname !== "string" || body.nickname.length === 0)
              return unavailable("provider_unavailable");
            return reply.code(200).send({ ok: true, account: body.nickname, checkedAt });
          } catch (error) {
            return unavailable(
              error instanceof Error && error.message === "mercado_livre_not_connected"
                ? "reconnect_required"
                : "provider_unavailable",
            );
          }
        }

        return unexpectedError(reply);
      } catch {
        return unexpectedError(reply);
      }
    },
  );
};
