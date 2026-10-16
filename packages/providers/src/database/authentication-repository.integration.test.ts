import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseUserId } from "@money-maker/contracts";
import type { VerifiedExternalIdentity } from "@money-maker/core/identity/authentication-repository";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { createPrismaAuthenticationRepository } from "./authentication-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const issuer = "https://issuer.authentication-test.example";

integration("PrismaAuthenticationRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: ReturnType<typeof createPrismaAuthenticationRepository>;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = createPrismaAuthenticationRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    await client.session.deleteMany();
    await client.externalIdentity.deleteMany({ where: { issuer } });
    await client.user.deleteMany({
      where: { email: { endsWith: "@authentication-test.example" } },
    });
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const identity = (subject: string, email: string): VerifiedExternalIdentity => ({
    issuer,
    subject,
    verifiedEmail: email,
  });

  it("recognizes only the seeded pre-authorized email", async () => {
    await expect(repository.isPreAuthorizedEmail("OWNER@EXAMPLE.COM")).resolves.toBe(true);
    await expect(repository.isPreAuthorizedEmail("other@example.com")).resolves.toBe(false);
  });

  it("binds repeated first logins to one local user", async () => {
    const verifiedIdentity = identity("subject-1", "person@authentication-test.example");

    const first = await repository.resolveOrCreateUser(verifiedIdentity);
    const second = await repository.resolveOrCreateUser(verifiedIdentity);

    expect(second).toEqual(first);
    await expect(
      client.externalIdentity.count({ where: { issuer, subject: verifiedIdentity.subject } }),
    ).resolves.toBe(1);
    await expect(
      client.user.count({ where: { email: "person@authentication-test.example" } }),
    ).resolves.toBe(1);
  });

  it("handles concurrent first logins without duplicate bindings", async () => {
    const verifiedIdentity = identity("subject-race", "race@authentication-test.example");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repository.resolveOrCreateUser(verifiedIdentity)),
    );

    expect(new Set(results.map((result) => result.userId)).size).toBe(1);
    await expect(
      client.externalIdentity.count({ where: { issuer, subject: verifiedIdentity.subject } }),
    ).resolves.toBe(1);
    await expect(
      client.user.count({ where: { email: "race@authentication-test.example" } }),
    ).resolves.toBe(1);
  });

  it("resolves a bearer identity only after it has been linked", async () => {
    const verifiedIdentity = identity("subject-linked", "linked@authentication-test.example");
    const user = await repository.resolveOrCreateUser(verifiedIdentity);

    await expect(
      repository.resolveLinkedUser({ issuer, subject: verifiedIdentity.subject }),
    ).resolves.toEqual(user);
    await expect(
      repository.resolveLinkedUser({ issuer, subject: "subject-not-linked" }),
    ).resolves.toBeNull();
  });

  it("expires and revokes opaque sessions without storing the raw token", async () => {
    const user = await repository.resolveOrCreateUser(
      identity("subject-session", "session@authentication-test.example"),
    );
    const token = `session-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 60_000);

    await repository.createSession({ userId: user.userId, token, expiresAt });

    const stored = await client.session.findFirst({ where: { userId: parseUserId(user.userId) } });
    expect(stored?.tokenHash).not.toBe(token);
    await expect(repository.resolveSession({ token, now: new Date() })).resolves.toEqual(user);
    await expect(
      repository.resolveSession({ token, now: new Date(Date.now() + 120_000) }),
    ).resolves.toBeNull();

    await repository.revokeSession({ token });
    await expect(repository.resolveSession({ token, now: new Date() })).resolves.toBeNull();
  });

  it("keeps session resolution bound to the session owner", async () => {
    const first = await repository.resolveOrCreateUser(
      identity("subject-first", "first@authentication-test.example"),
    );
    const second = await repository.resolveOrCreateUser(
      identity("subject-second", "second@authentication-test.example"),
    );
    const firstToken = `session-${randomUUID()}`;
    const secondToken = `session-${randomUUID()}`;

    await repository.createSession({
      userId: first.userId,
      token: firstToken,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await repository.createSession({
      userId: second.userId,
      token: secondToken,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      repository.resolveSession({ token: firstToken, now: new Date() }),
    ).resolves.toEqual(first);
    await expect(
      repository.resolveSession({ token: secondToken, now: new Date() }),
    ).resolves.toEqual(second);
  });
});
