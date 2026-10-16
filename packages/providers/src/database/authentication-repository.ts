import { createHash } from "node:crypto";
import type {
  AuthenticationRepository,
  AuthenticatedUser,
  VerifiedExternalIdentity,
} from "@money-maker/core/identity/authentication-repository";
import { normalizeInvitationEmail } from "@money-maker/core/identity/invitation-repository";
import { parseUserId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";

const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

const mapUser = (user: { id: string; email: string }): AuthenticatedUser => ({
  userId: parseUserId(user.id),
  verifiedEmail: user.email,
});

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

export const createPrismaAuthenticationRepository = (
  client: DatabaseClient,
): AuthenticationRepository => {
  const resolveOrCreateUser = async (
    identity: VerifiedExternalIdentity,
    retry = true,
  ): Promise<AuthenticatedUser> => {
    try {
      return await client.$transaction(async (transaction) => {
        const existing = await transaction.externalIdentity.findUnique({
          where: { issuer_subject: { issuer: identity.issuer, subject: identity.subject } },
          select: { user: { select: { id: true, email: true } } },
        });
        if (existing) return mapUser(existing.user);

        const email = normalizeInvitationEmail(identity.verifiedEmail);
        const user = await transaction.user.upsert({
          where: { email },
          create: { email },
          update: {},
          select: { id: true, email: true },
        });
        await transaction.externalIdentity.create({
          data: {
            issuer: identity.issuer,
            subject: identity.subject,
            userId: user.id,
          },
        });
        return mapUser(user);
      });
    } catch (error: unknown) {
      if (!retry || !isUniqueConstraintError(error)) throw error;
      return resolveOrCreateUser(identity, false);
    }
  };

  return {
    isPreAuthorizedEmail: async (email) => {
      const preAuthorized = await client.preAuthorizedEmail.findUnique({
        where: { email: normalizeInvitationEmail(email) },
        select: { email: true },
      });
      return preAuthorized !== null;
    },
    resolveOrCreateUser,
    resolveLinkedUser: async ({ issuer, subject }) => {
      const identity = await client.externalIdentity.findUnique({
        where: { issuer_subject: { issuer, subject } },
        select: { user: { select: { id: true, email: true } } },
      });
      return identity ? mapUser(identity.user) : null;
    },
    createSession: async ({ userId, token, expiresAt }) => {
      await client.session.create({
        data: { userId, tokenHash: hashSessionToken(token), expiresAt },
      });
    },
    resolveSession: async ({ token, now }) => {
      const session = await client.session.findFirst({
        where: {
          tokenHash: hashSessionToken(token),
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { user: { select: { id: true, email: true } } },
      });
      return session ? mapUser(session.user) : null;
    },
    revokeSession: async ({ token }) => {
      await client.session.updateMany({
        where: { tokenHash: hashSessionToken(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    },
  };
};
