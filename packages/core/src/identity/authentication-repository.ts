import type { UserId } from "@money-maker/contracts";
import type { AuthenticatedUser, VerifiedExternalIdentity } from "./authenticated-identity.js";

export type { AuthenticatedUser, VerifiedExternalIdentity } from "./authenticated-identity.js";

export interface AuthenticationRepository {
  isPreAuthorizedEmail(email: string): Promise<boolean>;
  resolveOrCreateUser(identity: VerifiedExternalIdentity): Promise<AuthenticatedUser>;
  resolveLinkedUser(
    identity: Readonly<{ issuer: string; subject: string }>,
  ): Promise<AuthenticatedUser | null>;
  createSession(input: Readonly<{ userId: UserId; token: string; expiresAt: Date }>): Promise<void>;
  resolveSession(input: Readonly<{ token: string; now: Date }>): Promise<AuthenticatedUser | null>;
  revokeSession(input: Readonly<{ token: string }>): Promise<void>;
}
