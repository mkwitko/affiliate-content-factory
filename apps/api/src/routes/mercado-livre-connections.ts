import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { createProviderConnection } from "@money-maker/core/providers/provider-connection";
import {
  exchangeMercadoLivreAuthorizationCode,
  fetchMercadoLivreNickname,
  mercadoLivreAuthorizationUrl,
} from "@money-maker/providers/mercado-livre/oauth-client";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import {
  MERCADO_LIVRE_STATE_COOKIE,
  parseCookie,
  sealMercadoLivreState,
  serializeCookie,
  unsealMercadoLivreState,
} from "../auth/session-cookie.js";
import type { ApiDependencies } from "../app.js";
import { authorizeMember } from "./provider-connections.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string };

const credentialsSchema = z
  .object({
    appId: z.string().trim().min(1).max(200),
    appSecret: z.string().trim().min(1).max(200),
  })
  .strict();

const callbackPath = "/v1/integrations/mercado-livre/callback";
const credentialsReference = (workspaceId: WorkspaceId) =>
  `secret://workspace/${workspaceId}/mercado-livre/app-credentials`;

// Matches sealMercadoLivreState's 10-minute JWT expiry.
const stateCookieMaxAge = 600;

const stateCookie = (value: string, secure: boolean, maxAge: number): string =>
  serializeCookie(MERCADO_LIVRE_STATE_COOKIE, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: callbackPath,
    maxAge,
  });

const workspaceParam = (value: string): WorkspaceId | null => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

export const registerMercadoLivreConnectionRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  const dependencies = options.dependencies;

  app.post<{ Params: Params; Body: unknown }>(
    "/v1/workspaces/:workspaceId/provider-connections/mercado-livre/credentials",
    async (request, reply) => {
      const authentication = await dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspaceParam(request.params.workspaceId);
      const body = credentialsSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const secretStore =
        dependencies.secretStoreForWorkspace?.(workspaceId) ?? dependencies.secretStore;
      if (!secretStore) return unexpectedError(reply);
      try {
        await secretStore.put({
          reference: credentialsReference(workspaceId),
          secret: JSON.stringify(body.data),
        });
        return reply.code(204).send();
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.get<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/provider-connections/mercado-livre/connect",
    async (request, reply) => {
      const authentication = await dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspaceParam(request.params.workspaceId);
      if (!workspaceId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (!dependencies.auth || !dependencies.publicApiUrl)
        return sendError(reply, 501, {
          code: "NOT_CONFIGURED",
          message: "Mercado Livre OAuth is not configured",
        });
      const secretStore =
        dependencies.secretStoreForWorkspace?.(workspaceId) ?? dependencies.secretStore;
      const credentialsRaw = secretStore
        ? await secretStore.get(credentialsReference(workspaceId))
        : null;
      if (!credentialsRaw)
        return sendError(reply, 409, {
          code: "CREDENTIALS_MISSING",
          message: "Save the Mercado Livre app credentials first",
        });
      const credentials = JSON.parse(credentialsRaw) as { appId: string; appSecret: string };
      const nonce = randomUUID();
      const state = await sealMercadoLivreState(
        { workspaceId, userId: authentication.userId, nonce },
        dependencies.auth.sessionSecret,
      );
      const redirectUri = new URL(callbackPath, dependencies.auth.webAppUrl).toString();
      const authorizationUrl = mercadoLivreAuthorizationUrl({
        appId: credentials.appId,
        redirectUri,
        state,
      });
      return reply
        .code(302)
        .header(
          "set-cookie",
          stateCookie(nonce, dependencies.auth.secureCookies, stateCookieMaxAge),
        )
        .header("location", authorizationUrl)
        .send();
    },
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    callbackPath,
    async (request, reply) => {
      if (!dependencies.auth || !dependencies.publicApiUrl)
        return sendError(reply, 501, {
          code: "NOT_CONFIGURED",
          message: "Mercado Livre OAuth is not configured",
        });
      const { code, state } = request.query;
      if (!code || !state)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const transaction = await unsealMercadoLivreState(state, dependencies.auth.sessionSecret);
      if (!transaction)
        return sendError(reply, 401, { code: "UNAUTHENTICATED", message: "Authentication failed" });
      // Bind the callback to the browser that started the transaction: the dashboard
      // session making this request must belong to the same user who initiated /connect,
      // and must present the single-use nonce cookie set at that time. This blocks an
      // attacker from completing their own OAuth transaction inside a victim's browser
      // (CSRF / account-linking) and from replaying a captured state after it is consumed.
      const authentication = await dependencies.authenticate(request);
      if (!authentication || authentication.userId !== transaction.userId)
        return sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const stateNonce = parseCookie(request.headers.cookie, MERCADO_LIVRE_STATE_COOKIE);
      if (!stateNonce || stateNonce !== transaction.nonce)
        return sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const authorization = await authorizeMember(
        dependencies,
        transaction.workspaceId,
        transaction.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const secretStore =
        dependencies.secretStoreForWorkspace?.(transaction.workspaceId) ?? dependencies.secretStore;
      if (!secretStore || !dependencies.providerConnections) return unexpectedError(reply);
      const credentialsRaw = await secretStore.get(credentialsReference(transaction.workspaceId));
      if (!credentialsRaw)
        return sendError(reply, 409, {
          code: "CREDENTIALS_MISSING",
          message: "Save the Mercado Livre app credentials first",
        });
      const credentials = JSON.parse(credentialsRaw) as { appId: string; appSecret: string };
      try {
        const redirectUri = new URL(callbackPath, dependencies.auth.webAppUrl).toString();
        const tokens = await exchangeMercadoLivreAuthorizationCode({
          appId: credentials.appId,
          appSecret: credentials.appSecret,
          code,
          redirectUri,
        });
        const nickname = await fetchMercadoLivreNickname({ accessToken: tokens.accessToken });
        const existing = (
          await dependencies.providerConnections.findAllForWorkspace({
            workspaceId: transaction.workspaceId,
          })
        ).find(
          (connection) =>
            connection.provider === "mercado_livre" && connection.accountId === tokens.userId,
        );
        let connection =
          existing ??
          createProviderConnection({
            workspaceId: transaction.workspaceId,
            provider: "mercado_livre",
            mode: "oauth",
            accountId: tokens.userId,
            ...(nickname ? { displayName: nickname } : {}),
            secretReference: `secret://workspace/${transaction.workspaceId}/mercado-livre/tokens/${randomUUID()}`,
          });
        if (existing && existing.status !== "active") {
          // Reconnecting after a disconnect: reactivate the row instead of leaving it
          // revoked forever, and rotate the secret reference along with the new tokens.
          const nextSecretReference = `secret://workspace/${transaction.workspaceId}/mercado-livre/tokens/${randomUUID()}`;
          const reactivated = await dependencies.providerConnections.reactivate?.({
            workspaceId: transaction.workspaceId,
            connectionId: existing.id,
            secretReference: nextSecretReference,
          });
          if (!reactivated) return unexpectedError(reply);
          connection = reactivated;
        }
        await secretStore.put({
          reference: connection.secretReference,
          secret: JSON.stringify({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
          }),
        });
        if (!existing) {
          const result = await dependencies.providerConnections.create(connection);
          if (!result.ok) return unexpectedError(reply);
        }
        const redirectTarget = new URL(dependencies.auth.webAppUrl);
        redirectTarget.searchParams.set("mercado_livre_connected", "1");
        return reply
          .code(302)
          .header("set-cookie", stateCookie("", dependencies.auth.secureCookies, 0))
          .header("location", redirectTarget.toString())
          .send();
      } catch {
        return sendError(reply, 502, {
          code: "PROVIDER_REQUEST_FAILED",
          message: "Mercado Livre did not accept this connection",
        });
      }
    },
  );
};
