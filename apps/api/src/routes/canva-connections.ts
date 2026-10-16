import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { createProviderConnection } from "@money-maker/core/providers/provider-connection";
import {
  canvaAuthorizationUrl,
  exchangeCanvaAuthorizationCode,
  fetchCanvaAccountId,
  generateCanvaPkce,
} from "@money-maker/providers/canva/oauth-client";
import { sendError, unexpectedError } from "../http/errors.js";
import {
  CANVA_STATE_COOKIE,
  parseCookie,
  sealCanvaState,
  serializeCookie,
  unsealCanvaState,
} from "../auth/session-cookie.js";
import type { ApiDependencies } from "../app.js";
import { authorizeMember } from "./provider-connections.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string };

const callbackPath = "/v1/integrations/canva/callback";
const canvaScope = "design:content:read design:meta:read";

// Matches sealCanvaState's 10-minute JWT expiry.
const stateCookieMaxAge = 600;

const stateCookie = (value: string, secure: boolean, maxAge: number): string =>
  serializeCookie(CANVA_STATE_COOKIE, value, {
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

export const registerCanvaConnectionRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  const dependencies = options.dependencies;

  app.get<{ Params: Params }>(
    "/v1/workspaces/:workspaceId/provider-connections/canva/connect",
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
      if (!dependencies.auth || !dependencies.publicApiUrl || !dependencies.canva)
        return sendError(reply, 501, {
          code: "NOT_CONFIGURED",
          message: "Canva OAuth is not configured",
        });
      const nonce = randomUUID();
      const { codeVerifier, codeChallenge } = generateCanvaPkce();
      const state = await sealCanvaState(
        { workspaceId, userId: authentication.userId, nonce, codeVerifier },
        dependencies.auth.sessionSecret,
      );
      const redirectUri = new URL(callbackPath, dependencies.auth.webAppUrl).toString();
      const authorizationUrl = canvaAuthorizationUrl({
        clientId: dependencies.canva.clientId,
        redirectUri,
        // The codeVerifier never leaves the server: only the opaque nonce travels in the
        // OAuth `state` query parameter, and is matched against the sealed cookie on callback.
        state: nonce,
        codeChallenge,
        scope: canvaScope,
      });
      return reply
        .code(302)
        .header(
          "set-cookie",
          stateCookie(state, dependencies.auth.secureCookies, stateCookieMaxAge),
        )
        .header("location", authorizationUrl)
        .send();
    },
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    callbackPath,
    async (request, reply) => {
      if (!dependencies.auth || !dependencies.publicApiUrl || !dependencies.canva)
        return sendError(reply, 501, {
          code: "NOT_CONFIGURED",
          message: "Canva OAuth is not configured",
        });
      const { code, state } = request.query;
      if (!code || !state)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const stateCookieValue = parseCookie(request.headers.cookie, CANVA_STATE_COOKIE);
      if (!stateCookieValue)
        return sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const transaction = await unsealCanvaState(stateCookieValue, dependencies.auth.sessionSecret);
      if (!transaction)
        return sendError(reply, 401, { code: "UNAUTHENTICATED", message: "Authentication failed" });
      // Bind the callback to the browser that started the transaction, the same way
      // mercado-livre-connections.ts does: the dashboard session must belong to the same
      // user who initiated /connect, and the `state` query parameter must match the
      // single-use nonce sealed in the httpOnly cookie set at that time.
      const authentication = await dependencies.authenticate(request);
      if (!authentication || authentication.userId !== transaction.userId)
        return sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (state !== transaction.nonce)
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
      try {
        const redirectUri = new URL(callbackPath, dependencies.auth.webAppUrl).toString();
        const tokens = await exchangeCanvaAuthorizationCode({
          clientId: dependencies.canva.clientId,
          clientSecret: dependencies.canva.clientSecret,
          code,
          redirectUri,
          codeVerifier: transaction.codeVerifier,
        });
        const accountId = await fetchCanvaAccountId({ accessToken: tokens.accessToken });
        const existing = (
          await dependencies.providerConnections.findAllForWorkspace({
            workspaceId: transaction.workspaceId,
          })
        ).find(
          (connection) => connection.provider === "canva" && connection.accountId === accountId,
        );
        let connection =
          existing ??
          createProviderConnection({
            workspaceId: transaction.workspaceId,
            provider: "canva",
            mode: "oauth",
            accountId,
            secretReference: `secret://workspace/${transaction.workspaceId}/canva/tokens/${randomUUID()}`,
          });
        if (existing && existing.status !== "active") {
          // Reconnecting after a disconnect: reactivate the row instead of leaving it
          // revoked forever, and rotate the secret reference along with the new tokens.
          const nextSecretReference = `secret://workspace/${transaction.workspaceId}/canva/tokens/${randomUUID()}`;
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
        redirectTarget.searchParams.set("canva_connected", "1");
        return reply
          .code(302)
          .header("set-cookie", stateCookie("", dependencies.auth.secureCookies, 0))
          .header("location", redirectTarget.toString())
          .send();
      } catch {
        return sendError(reply, 502, {
          code: "PROVIDER_REQUEST_FAILED",
          message: "Canva did not accept this connection",
        });
      }
    },
  );
};
