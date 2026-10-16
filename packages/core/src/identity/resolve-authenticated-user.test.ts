import { describe, expect, it } from "vitest";
import type {
  AuthenticatedUser,
  AuthenticationRepository,
  VerifiedExternalIdentity,
} from "./authentication-repository.js";
import { resolveAuthenticatedUser } from "./resolve-authenticated-user.js";

const verifiedIdentity: VerifiedExternalIdentity = {
  issuer: " https://issuer.example/ ",
  subject: "subject-1",
  verifiedEmail: " Person@Example.com ",
};

describe("resolveAuthenticatedUser", () => {
  it("normalizes the verified identity before binding it", async () => {
    const received: VerifiedExternalIdentity[] = [];
    const user: AuthenticatedUser = {
      userId: "11111111-1111-4111-8111-111111111111" as AuthenticatedUser["userId"],
      verifiedEmail: "person@example.com",
    };
    const repository: AuthenticationRepository = {
      isPreAuthorizedEmail: async () => false,
      resolveOrCreateUser: async (identity) => {
        received.push(identity);
        return user;
      },
      resolveLinkedUser: async () => null,
      createSession: async () => undefined,
      resolveSession: async () => null,
      revokeSession: async () => undefined,
    };

    await expect(resolveAuthenticatedUser(verifiedIdentity, repository)).resolves.toEqual(user);
    expect(received).toEqual([
      {
        issuer: "https://issuer.example/",
        subject: "subject-1",
        verifiedEmail: "person@example.com",
      },
    ]);
  });
});
