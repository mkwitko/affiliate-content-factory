import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createInMemoryGenerationBudgetLedger } from "@money-maker/core/costs/generation-budget";
import type { GenerationSettings } from "@money-maker/core/costs/generation-settings";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import {
  connectCloudProviderTool,
  getGenerationBudgetTool,
  setGenerationBudgetTool,
} from "./generation-budget.js";

const ownerId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const fakeDeps = (options: {
  verify: () => Promise<"deployed" | "app_missing" | "invalid">;
  role?: "owner" | "operator";
}) => {
  const rows: ProviderConnection[] = [];
  const secrets = new Map<string, string>();
  const settings = new Map<string, GenerationSettings>();
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "W" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
    findMembership: async ({ workspaceId: id }) =>
      id === workspaceId
        ? { workspaceId, userId: ownerId, role: options.role ?? "owner", status: "active" }
        : null,
    addMembership: async () => undefined,
  };
  const providerConnections = {
    create: async (connection: ProviderConnection) => {
      if (
        rows.some(
          (row) => row.provider === connection.provider && row.accountId === connection.accountId,
        )
      )
        return { ok: false as const, code: "duplicate_account" as const };
      rows.push(connection);
      return { ok: true as const, connection };
    },
    findAllForWorkspace: async () => rows,
    findForWorkspace: async () => null,
    revoke: async () => undefined,
  };
  const secretStore = {
    put: async ({ reference, secret }: { reference: string; secret: string }) => {
      secrets.set(reference, secret);
    },
    get: async (reference: string) => secrets.get(reference) ?? null,
    delete: async (reference: string) => {
      secrets.delete(reference);
    },
  };
  const generationSettings = {
    get: async (id: string) => settings.get(id) ?? null,
    put: async (id: string, value: GenerationSettings) => {
      settings.set(id, value);
    },
  };
  return {
    authenticate: async () => ({ userId: ownerId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces,
    providerConnections,
    secretStore,
    generationSettings,
    generationBudgetLedger: createInMemoryGenerationBudgetLedger(),
    verifyModalCredentials: options.verify,
    aiGatewayCredits: async (apiKey: string) =>
      apiKey === "vck_good" ? { balanceUsd: 9.91, usedUsd: 25.08 } : ("invalid" as const),
  } as unknown as McpDependencies & {
    providerConnections: typeof providerConnections;
    secretStore: typeof secretStore;
    generationSettings: typeof generationSettings;
  };
};

describe("connect_cloud_provider", () => {
  it("stores a verified Modal token in the secret store, never in the result", async () => {
    const deps = fakeDeps({ verify: async () => "app_missing" });
    const result = await connectCloudProviderTool(
      { workspaceId, provider: "modal", tokenId: "ak-1", tokenSecret: "as-secret" },
      ownerId,
      deps,
    );
    expect(result).toMatchObject({ ok: true, value: { provider: "modal", appDeployed: false } });
    expect(JSON.stringify(result)).not.toContain("as-secret");
    const [connection] = await deps.providerConnections.findAllForWorkspace();
    expect(
      JSON.parse((await deps.secretStore.get(connection?.secretReference ?? "")) ?? ""),
    ).toEqual({
      tokenId: "ak-1",
      tokenSecret: "as-secret",
    });
  });

  it("refuses a token Modal rejects and stores nothing", async () => {
    const deps = fakeDeps({ verify: async () => "invalid" });
    expect(
      await connectCloudProviderTool(
        { workspaceId, provider: "modal", tokenId: "ak-1", tokenSecret: "bad" },
        ownerId,
        deps,
      ),
    ).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(await deps.providerConnections.findAllForWorkspace()).toEqual([]);
  });

  it("is owner-only and refuses a second connection of the same token", async () => {
    expect(
      await connectCloudProviderTool(
        { workspaceId, provider: "modal", tokenId: "ak-1", tokenSecret: "s" },
        ownerId,
        fakeDeps({ verify: async () => "deployed", role: "operator" }),
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
    const deps = fakeDeps({ verify: async () => "deployed" });
    const input = { workspaceId, provider: "modal", tokenId: "ak-1", tokenSecret: "s" };
    await connectCloudProviderTool(input, ownerId, deps);
    expect(await connectCloudProviderTool(input, ownerId, deps)).toEqual({
      ok: false,
      error: "CONNECTION_ALREADY_EXISTS",
    });
  });
});

describe("connect_cloud_provider: Vercel AI Gateway", () => {
  it("stores a working key encrypted, keyed by a digest, and reports the live balance", async () => {
    const deps = fakeDeps({ verify: async () => "deployed" });
    const result = await connectCloudProviderTool(
      { workspaceId, provider: "vercel_ai_gateway", apiKey: "vck_good" },
      ownerId,
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { provider: "vercel_ai_gateway", balanceUsd: 9.91 },
    });
    expect(JSON.stringify(result)).not.toContain("vck_good");
    const [connection] = await deps.providerConnections.findAllForWorkspace();
    expect(connection?.accountId).toMatch(/^key-sha256:[0-9a-f]{16}$/);
    expect(
      JSON.parse((await deps.secretStore.get(connection?.secretReference ?? "")) ?? ""),
    ).toEqual({
      apiKey: "vck_good",
    });
    const read = await getGenerationBudgetTool({ workspaceId }, ownerId, deps);
    expect(read).toMatchObject({
      ok: true,
      value: { prepaid: [{ provider: "vercel_ai_gateway", balanceUsd: 9.91 }] },
    });
  });

  it("refuses a rejected key and credentials of the other provider", async () => {
    const deps = fakeDeps({ verify: async () => "deployed" });
    expect(
      await connectCloudProviderTool(
        { workspaceId, provider: "vercel_ai_gateway", apiKey: "vck_bad" },
        ownerId,
        deps,
      ),
    ).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(
      await connectCloudProviderTool(
        { workspaceId, provider: "vercel_ai_gateway", tokenId: "ak", tokenSecret: "as" },
        ownerId,
        deps,
      ),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(await deps.providerConnections.findAllForWorkspace()).toEqual([]);
  });
});

describe("set_generation_budget / get_generation_budget", () => {
  it("stores the cap and free credit in minor units and reports this month's use", async () => {
    const deps = fakeDeps({ verify: async () => "deployed" });
    expect(
      await setGenerationBudgetTool(
        { workspaceId, monthlyCapBrl: 150, freeCredits: { modal: { usd: 30 } } },
        ownerId,
        deps,
      ),
    ).toMatchObject({ ok: true });
    expect(await deps.generationSettings.get(workspaceId)).toEqual({
      monthlyCapMinor: 15_000,
      freeCredits: { modal: { amountMinor: 3_000, currency: "USD" } },
    });
    expect(await getGenerationBudgetTool({ workspaceId }, ownerId, deps)).toMatchObject({
      ok: true,
      value: {
        paid: { capBrl: 150, spentBrl: 0, remainingBrl: 150 },
        free: [
          {
            provider: "modal",
            creditUsd: 30,
            creditSource: "declared_by_owner",
            usedUsd: 0,
            remainingUsd: 30,
          },
        ],
      },
    });
  });

  it("refuses a cap above the input guard and a non-owner", async () => {
    const deps = fakeDeps({ verify: async () => "deployed" });
    expect(
      await setGenerationBudgetTool({ workspaceId, monthlyCapBrl: 5_000 }, ownerId, deps),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(
      await setGenerationBudgetTool(
        { workspaceId, monthlyCapBrl: 100 },
        ownerId,
        fakeDeps({ verify: async () => "deployed", role: "operator" }),
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
