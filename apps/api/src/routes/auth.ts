import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { resolveAuthenticatedUser } from "@money-maker/core/identity/resolve-authenticated-user";
import { sendError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";
import {
  AUTH_SESSION_COOKIE,
  AUTH_TRANSACTION_COOKIE,
  parseCookie,
  sealAuthTransaction,
  serializeCookie,
  unsealAuthTransaction,
} from "../auth/session-cookie.js";

type AuthRouteOptions = Readonly<{ dependencies: ApiDependencies }>;

type CallbackQuery = Readonly<{ code?: string; state?: string }>;

const transactionMaxAge = 300;
const sessionMaxAge = 60 * 60 * 24 * 7;

const randomValue = (): string => randomBytes(32).toString("base64url");

const cookie = (name: string, value: string, secure: boolean, maxAge: number): string =>
  serializeCookie(name, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: "/",
    maxAge,
  });

const invalidAuthentication = (reply: Parameters<typeof sendError>[0]) =>
  sendError(reply, 401, {
    code: "UNAUTHENTICATED",
    message: "Authentication failed",
  });

const configuredOrigin = (webAppUrl: string): string | null => {
  try {
    return new URL(webAppUrl).origin;
  } catch {
    return null;
  }
};

const callbackUrl = (request: FastifyRequest, redirectUri: string): string => {
  const url = new URL(redirectUri);
  url.search = new URL(request.url, `${url.protocol}//${url.host}`).search;
  return url.toString();
};

export const registerAuthRoutes = async (
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> => {
  const dependencies = options.dependencies.auth;
  if (!dependencies) return;

  app.get("/v1/auth/login", async (_request, reply) => {
    try {
      const transaction = {
        state: randomValue(),
        nonce: randomValue(),
        codeVerifier: randomValue(),
      };
      const authorizationUrl = await dependencies.oidcClient.authorizationUrl(transaction);
      const transactionCookie = await sealAuthTransaction(transaction, dependencies.sessionSecret);
      return reply
        .code(302)
        .header(
          "set-cookie",
          cookie(
            AUTH_TRANSACTION_COOKIE,
            transactionCookie,
            dependencies.secureCookies,
            transactionMaxAge,
          ),
        )
        .header("location", authorizationUrl)
        .send();
    } catch {
      return invalidAuthentication(reply);
    }
  });

  app.get<{ Querystring: CallbackQuery }>("/v1/auth/callback", async (request, reply) => {
    const transactionCookie = parseCookie(request.headers.cookie, AUTH_TRANSACTION_COOKIE);
    const transaction = transactionCookie
      ? await unsealAuthTransaction(transactionCookie, dependencies.sessionSecret)
      : null;
    if (!request.query.code || !request.query.state || !transaction) {
      return invalidAuthentication(reply);
    }
    if (transaction.state !== request.query.state) return invalidAuthentication(reply);

    try {
      const exchanged = await dependencies.oidcClient.exchangeCode({
        callbackUrl: callbackUrl(request, dependencies.redirectUri),
        state: transaction.state,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
      });
      const identity = await dependencies.tokenVerifier.verifyCallback(exchanged.idToken);
      const user = await resolveAuthenticatedUser(identity, dependencies.authentication);
      const token = randomValue();
      await dependencies.authentication.createSession({
        userId: user.userId,
        token,
        expiresAt: new Date(Date.now() + sessionMaxAge * 1000),
      });
      return reply
        .code(302)
        .header("set-cookie", [
          cookie(AUTH_SESSION_COOKIE, token, dependencies.secureCookies, sessionMaxAge),
          cookie(AUTH_TRANSACTION_COOKIE, "", dependencies.secureCookies, 0),
        ])
        .header("location", dependencies.webAppUrl)
        .send();
    } catch {
      return invalidAuthentication(reply);
    }
  });

  app.get("/v1/auth/session", async (request, reply) => {
    const token = parseCookie(request.headers.cookie, AUTH_SESSION_COOKIE);
    if (!token) return reply.code(200).send({ authenticated: false });
    try {
      const user = await dependencies.authentication.resolveSession({
        token,
        now: new Date(),
      });
      if (!user) return reply.code(200).send({ authenticated: false });
      return reply.code(200).send({
        authenticated: true,
        user: { id: user.userId, email: user.verifiedEmail },
      });
    } catch {
      return reply.code(200).send({ authenticated: false });
    }
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || origin !== configuredOrigin(dependencies.webAppUrl)) {
      return sendError(reply, 403, { code: "FORBIDDEN", message: "Origin not allowed" });
    }
    const token = parseCookie(request.headers.cookie, AUTH_SESSION_COOKIE);
    try {
      if (token) await dependencies.authentication.revokeSession({ token });
      return reply
        .code(204)
        .header("set-cookie", cookie(AUTH_SESSION_COOKIE, "", dependencies.secureCookies, 0))
        .send();
    } catch {
      return invalidAuthentication(reply);
    }
  });
};
