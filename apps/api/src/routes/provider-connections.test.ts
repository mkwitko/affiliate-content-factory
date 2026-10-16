import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId, type MembershipRole } from "@money-maker/contracts";
import type { WorkspaceMembership } from "@money-maker/core/identity/authorization";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type {
  PostForMeClient,
  PostForMeSocialAccount,
} from "@money-maker/providers/post-for-me/client";
import { buildApp, type ApiDependencies } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const reviewerId = parseUserId("84d55b67-e059-4942-8191-b42a693a3525");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const account = (id: string, username: string): PostForMeSocialAccount => ({
  id,
  platform: "instagram",
  username,
  status: "active",
});

const defaultAccounts: readonly PostForMeSocialAccount[] = [
  account("acc-ig-account-one", "ig-account-one"),
  account("acc-ig-account-two", "ig-account-two"),
  account("acc-default", "default"),
];

const createFixture = (
  authenticated = true,
  role: MembershipRole = "owner",
  duplicate = false,
  socialAccounts: readonly PostForMeSocialAccount[] = defaultAccounts,
) => {
  const records: ProviderConnection[] = [];
  const secrets = new Map<string, string>();
  const providerConnections: ProviderConnectionRepository = {
    create: async (connection) => {
      if (duplicate) return { ok: false, code: "duplicate_account" };
      records.push(connection);
      return { ok: true, connection };
    },
    findAllForWorkspace: async ({ workspaceId: targetWorkspaceId }) =>
      records.filter((connection) => connection.workspaceId === targetWorkspaceId),
    findForWorkspace: async ({ workspaceId: targetWorkspaceId, connectionId }) =>
      records.find(
        (connection) =>
          connection.workspaceId === targetWorkspaceId && connection.id === connectionId,
      ) ?? null,
    revoke: async ({ workspaceId: targetWorkspaceId, connectionId }) => {
      const connection = records.find(
        (candidate) => candidate.workspaceId === targetWorkspaceId && candidate.id === connectionId,
      );
      if (connection) {
        records[records.indexOf(connection)] = { ...connection, status: "revoked" };
      }
    },
  };
  const secretStore: SecretStore = {
    put: async ({ reference, secret }) => void secrets.set(reference, secret),
    get: async (reference) => secrets.get(reference) ?? null,
    delete: async (reference) => void secrets.delete(reference),
  };
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async ({ workspaceId: targetWorkspaceId }) =>
      targetWorkspaceId === workspaceId ? { id: workspaceId, name: "Workspace" } : null,
    findMembership: async ({ workspaceId: targetWorkspaceId, userId: targetUserId }) =>
      targetWorkspaceId === workspaceId
        ? ({
            workspaceId,
            userId: targetUserId,
            role,
            status: "active",
          } satisfies WorkspaceMembership)
        : null,
    addMembership: async () => undefined,
  };
  const invitation = {} as InvitationDependencies;
  const postForMeClient: PostForMeClient = {
    listSocialAccounts: async (apiKey) => {
      if (apiKey === "pfm_invalid_key") throw new Error("invalid_api_key");
      return socialAccounts;
    },
    createSocialPost: async () => {
      throw new Error("not_implemented");
    },
    findSocialPostByExternalId: async () => {
      throw new Error("not_implemented");
    },
    getSocialPostMetrics: async () => null,
    createWebhook: async () => {
      throw new Error("not_implemented");
    },
  };
  const dependencies: ApiDependencies = {
    invitation,
    workspaces,
    providerConnections,
    secretStore,
    postForMeClient,
    authenticate: async () =>
      authenticated
        ? {
            userId: role === "reviewer" ? reviewerId : userId,
            verifiedEmail: role === "reviewer" ? "reviewer@example.com" : "owner@example.com",
          }
        : null,
  };
  return { dependencies, records, secrets };
};

describe("provider connection routes", () => {
  it("stores an API key outside the response and scopes listing to the workspace", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "ig-account-one" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("pfm_secret_test");
    expect(created.body).not.toContain("secretReference");
    expect(fixture.secrets.size).toBe(1);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connections).toHaveLength(1);
    expect(listed.json().connections[0]).toMatchObject({
      accountId: "acc-ig-account-one",
      displayName: "ig-account-one",
    });

    const otherWorkspace = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${otherWorkspaceId}/provider-connections`,
    });
    expect(otherWorkspace.statusCode).toBe(404);
    await app.close();
  });

  it("resolves the Instagram account id case-insensitively and ignoring a leading @", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "@IG-Account-One" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().connection).toMatchObject({
      accountId: "acc-ig-account-one",
      displayName: "ig-account-one",
    });
    await app.close();
  });

  it("rejects an invalid Post For Me API key without storing anything", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_invalid_key", accountId: "ig-account-one" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: "INVALID_API_KEY", message: expect.any(String) },
    });
    expect(response.body).not.toContain("pfm_invalid_key");
    expect(fixture.secrets.size).toBe(0);
    expect(fixture.records).toHaveLength(0);
    await app.close();
  });

  it("reports available accounts when the submitted handle isn't found for this key", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "not-connected-handle" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: "ACCOUNT_NOT_FOUND",
        message: expect.any(String),
        availableAccounts: ["ig-account-one", "ig-account-two", "default"],
      },
    });
    expect(fixture.secrets.size).toBe(0);
    await app.close();
  });

  it("allows a second connection with a different Instagram account id", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const first = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_one", accountId: "ig-account-one" },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_two", accountId: "ig-account-two" },
    });
    expect(second.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections`,
    });
    expect(listed.json().connections).toHaveLength(2);
    expect(fixture.secrets.size).toBe(2);
    await app.close();
  });

  it("rejects a request with a missing account id", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("rejects unauthenticated configuration requests", async () => {
    const app = buildApp(createFixture(false).dependencies);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "ig-account-one" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("allows reviewers to list but not create or revoke connections", async () => {
    const fixture = createFixture(true, "reviewer");
    fixture.records.push({
      id: "connection-1",
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      accountId: "default",
      secretReference: `secret://workspace/${workspaceId}/provider-connection/connection-1`,
      status: "active",
    });
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "ig-account-one" },
    });
    expect(created.statusCode).toBe(403);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/provider-connections`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().connections).toHaveLength(1);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${workspaceId}/provider-connections/connection-1`,
    });
    expect(revoked.statusCode).toBe(403);
    await app.close();
  });

  it("returns a safe conflict and removes the staged secret for a duplicate account", async () => {
    const fixture = createFixture(true, "owner", true);
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/post-for-me`,
      payload: { apiKey: "pfm_secret_test", accountId: "ig-account-one" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "CONNECTION_ALREADY_EXISTS", message: "Connection already exists" },
    });
    expect(fixture.secrets.size).toBe(0);
    await app.close();
  });
});

describe("provider connection test route", () => {
  const postForMeConnection: ProviderConnection = {
    id: "connection-1",
    workspaceId,
    provider: "post_for_me",
    mode: "api_key",
    accountId: "acc-ig-account-one",
    displayName: "ig-account-one",
    secretReference: `secret://workspace/${workspaceId}/provider-connection/connection-1`,
    status: "active",
  };

  it("confirms a healthy Post For Me connection", async () => {
    const fixture = createFixture();
    fixture.records.push(postForMeConnection);
    fixture.secrets.set(postForMeConnection.secretReference, "pfm_secret_test");
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/connection-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, account: "@ig-account-one" });
    expect(response.json().checkedAt).toEqual(expect.any(String));
    await app.close();
  });

  it("reports an invalid Post For Me key without leaking it", async () => {
    const fixture = createFixture();
    fixture.records.push(postForMeConnection);
    fixture.secrets.set(postForMeConnection.secretReference, "pfm_invalid_key");
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/connection-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: "invalid_api_key" });
    expect(response.body).not.toContain("pfm_invalid_key");
    await app.close();
  });

  it("reports a missing account when the stored id is no longer present for this key", async () => {
    const fixture = createFixture(true, "owner", false, [account("acc-other", "someone-else")]);
    fixture.records.push(postForMeConnection);
    fixture.secrets.set(postForMeConnection.secretReference, "pfm_secret_test");
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/connection-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: "account_missing" });
    await app.close();
  });

  it("lets reviewers test a connection", async () => {
    const fixture = createFixture(true, "reviewer");
    fixture.records.push(postForMeConnection);
    fixture.secrets.set(postForMeConnection.secretReference, "pfm_secret_test");
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/connection-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    await app.close();
  });

  it("rate limits repeated tests of the same connection", async () => {
    const fixture = createFixture(true, "reviewer");
    fixture.records.push(postForMeConnection);
    fixture.secrets.set(postForMeConnection.secretReference, "pfm_secret_test");
    const app = buildApp(fixture.dependencies);
    await app.ready();
    const url = `/v1/workspaces/${workspaceId}/provider-connections/connection-1/test`;

    const first = await app.inject({ method: "POST", url });
    const second = await app.inject({ method: "POST", url });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it("confirms a healthy Mercado Livre connection", async () => {
    const fixture = createFixture();
    const connection: ProviderConnection = {
      id: "ml-1",
      workspaceId,
      provider: "mercado_livre",
      mode: "oauth",
      accountId: "123456",
      secretReference: `secret://workspace/${workspaceId}/mercado-livre/tokens/ml-1`,
      status: "active",
    };
    fixture.records.push(connection);
    fixture.dependencies = {
      ...fixture.dependencies,
      mercadoLivreClientForWorkspace: () => ({
        request: async () =>
          new Response(JSON.stringify({ nickname: "LOJA_OFICIAL" }), { status: 200 }),
      }),
    };
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/ml-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, account: "LOJA_OFICIAL" });
    await app.close();
  });

  it("reports that Mercado Livre needs to be reconnected", async () => {
    const fixture = createFixture();
    const connection: ProviderConnection = {
      id: "ml-1",
      workspaceId,
      provider: "mercado_livre",
      mode: "oauth",
      accountId: "123456",
      secretReference: `secret://workspace/${workspaceId}/mercado-livre/tokens/ml-1`,
      status: "active",
    };
    fixture.records.push(connection);
    fixture.dependencies = {
      ...fixture.dependencies,
      mercadoLivreClientForWorkspace: () => ({
        request: async () => {
          throw new Error("mercado_livre_not_connected");
        },
      }),
    };
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/ml-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: "reconnect_required" });
    await app.close();
  });

  it("reports Mercado Livre as unavailable on a server error", async () => {
    const fixture = createFixture();
    const connection: ProviderConnection = {
      id: "ml-1",
      workspaceId,
      provider: "mercado_livre",
      mode: "oauth",
      accountId: "123456",
      secretReference: `secret://workspace/${workspaceId}/mercado-livre/tokens/ml-1`,
      status: "active",
    };
    fixture.records.push(connection);
    fixture.dependencies = {
      ...fixture.dependencies,
      mercadoLivreClientForWorkspace: () => ({
        request: async () => new Response(null, { status: 500 }),
      }),
    };
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/ml-1/test`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: "provider_unavailable" });
    await app.close();
  });

  it("returns 404 for a connection outside the workspace", async () => {
    const fixture = createFixture();
    const app = buildApp(fixture.dependencies);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/provider-connections/missing/test`,
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
