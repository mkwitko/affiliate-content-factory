import type { UserId } from "@money-maker/contracts";

export type VerifiedExternalIdentity = Readonly<{
  issuer: string;
  subject: string;
  verifiedEmail: string;
}>;

export type AuthenticatedUser = Readonly<{
  userId: UserId;
  verifiedEmail: string;
}>;
