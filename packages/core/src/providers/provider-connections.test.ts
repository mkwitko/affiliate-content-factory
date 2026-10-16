import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createProviderConnection,
  revokeProviderConnection,
  type ProviderConnection,
} from "./provider-connection.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");

describe("provider connections", () => {
  it("creates a workspace-scoped API-key connection without storing the key", () => {
    const connection = createProviderConnection({
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      secretReference: "secret://workspace/post-for-me/default",
      accountId: "pfm-account-1",
    });

    expect(connection).toMatchObject({
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      secretReference: "secret://workspace/post-for-me/default",
      accountId: "pfm-account-1",
      status: "active",
    });
    expect(JSON.stringify(connection)).not.toContain("api-key");
  });

  it("stores an optional display label without affecting the account id", () => {
    const connection = createProviderConnection({
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      secretReference: "secret://workspace/post-for-me/default",
      accountId: "acc_12345abc",
      displayName: "exampleshop.home",
    });

    expect(connection).toMatchObject({
      accountId: "acc_12345abc",
      displayName: "exampleshop.home",
    });
  });

  it("omits displayName entirely when none is given", () => {
    const connection = createProviderConnection({
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      secretReference: "secret://workspace/post-for-me/default",
      accountId: "pfm-account-1",
    });

    expect(connection).not.toHaveProperty("displayName");
  });

  it("rejects an empty secret reference", () => {
    expect(() =>
      createProviderConnection({
        workspaceId,
        provider: "post_for_me",
        mode: "api_key",
        secretReference: "",
        accountId: "pfm-account-1",
      }),
    ).toThrow("secret reference");
  });

  it("revocation prevents a connection from being used", () => {
    const connection: ProviderConnection = createProviderConnection({
      workspaceId,
      provider: "post_for_me",
      mode: "api_key",
      secretReference: "secret://workspace/post-for-me/default",
      accountId: "pfm-account-1",
    });

    expect(revokeProviderConnection(connection)).toMatchObject({ status: "revoked" });
  });
});
