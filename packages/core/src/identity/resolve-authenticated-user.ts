import { normalizeInvitationEmail } from "./invitation-repository.js";
import type {
  AuthenticationRepository,
  AuthenticatedUser,
  VerifiedExternalIdentity,
} from "./authentication-repository.js";

const normalizedRequired = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Authenticated identity ${field} is required`);
  return normalized;
};

export const resolveAuthenticatedUser = async (
  identity: VerifiedExternalIdentity,
  repository: AuthenticationRepository,
): Promise<AuthenticatedUser> =>
  repository.resolveOrCreateUser({
    issuer: normalizedRequired(identity.issuer, "issuer"),
    subject: normalizedRequired(identity.subject, "subject"),
    verifiedEmail: normalizeInvitationEmail(identity.verifiedEmail),
  });
