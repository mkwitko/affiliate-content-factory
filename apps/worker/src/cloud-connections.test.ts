import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { modalSetupFor, parseModalSecret } from "./cloud-connections.js";

const workspaceId = parseWorkspaceId("82a6b5ba-e755-4417-8722-a0b0ba82d551");
const now = new Date("2026-10-14T15:00:00Z");
const modalConnection = {
  id: "c1",
  workspaceId,
  provider: "modal" as const,
  mode: "api_key" as const,
  secretReference: "secret://modal",
  accountId: "ak-1",
  status: "active" as const,
};
const deps = (over: Partial<Parameters<typeof modalSetupFor>[0]> = {}) => ({
  connections: { findAllForWorkspace: async () => [modalConnection] },
  secrets: () => ({
    get: async () => JSON.stringify({ tokenId: "ak-1", tokenSecret: "as-1" }),
    put: async () => undefined,
    delete: async () => undefined,
  }),
  settings: {
    get: async () => ({
      monthlyCapMinor: 10_000,
      freeCredits: { modal: { amountMinor: 3_000, currency: "USD" as const } },
    }),
    put: async () => undefined,
  },
  env: {},
  now: () => now,
  ...over,
});

describe("modalSetupFor", () => {
  it("uses the workspace's Modal connection with free credit first", async () => {
    const setup = await modalSetupFor(deps(), workspaceId);
    expect(setup?.source).toBe("connection");
    expect(setup?.credentials).toEqual({ tokenId: "ak-1", tokenSecret: "as-1" });
    expect(setup?.policies.map((policy) => policy.key)).toEqual([
      "free-modal-2026-10",
      "paid-2026-10",
    ]);
  });

  it("uses the active connection after a reconnect left the old one revoked", async () => {
    const setup = await modalSetupFor(
      deps({
        connections: {
          findAllForWorkspace: async () => [
            { ...modalConnection, id: "old", status: "revoked" as const },
            modalConnection,
          ],
        },
      }),
      workspaceId,
    );
    expect(setup?.source).toBe("connection");
  });

  it("keeps today's env setup working, paid only, when no connection exists", async () => {
    const setup = await modalSetupFor(
      deps({
        connections: { findAllForWorkspace: async () => [] },
        settings: { get: async () => null },
        env: {
          CLOUD_GPU_PROVIDERS: "modal",
          MODAL_TOKEN_ID: "ak-env",
          MODAL_TOKEN_SECRET: "as-env",
        },
      }),
      workspaceId,
    );
    expect(setup).toMatchObject({ source: "env", credentials: { tokenId: "ak-env" } });
    expect(setup?.policies.map((policy) => policy.key)).toEqual(["paid-2026-10"]);
  });

  it("returns nothing under local_only, for a revoked connection, or a malformed secret", async () => {
    expect(
      await modalSetupFor(deps({ env: { GENERATION_POLICY: "local_only" } }), workspaceId),
    ).toBeNull();
    expect(
      await modalSetupFor(
        deps({
          connections: {
            findAllForWorkspace: async () => [{ ...modalConnection, status: "revoked" as const }],
          },
        }),
        workspaceId,
      ),
    ).toBeNull();
    expect(parseModalSecret("not json")).toBeNull();
    expect(parseModalSecret(JSON.stringify({ tokenId: "ak" }))).toBeNull();
  });
});
