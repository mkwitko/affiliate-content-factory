import { parseWorkspaceId } from "@money-maker/contracts";
import { CLOUD_WORKER_TOKEN_NAME } from "@money-maker/core/generation/home-routes";
import { DEFAULT_ROUTES } from "@money-maker/core/generation/route-repository";
import type { GenerationRoute } from "@money-maker/core/generation/routing";
import type { HomeWorkerToken } from "@money-maker/core/home-worker/tokens";
import { describe, expect, it } from "vitest";
import { CLOUD_CAPABILITY_ROUTES, cloudCapabilities, createCloudWorker } from "./cloud-worker.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-14T18:00:00Z");
const qualified = (routes: readonly GenerationRoute[]) =>
  routes.map((route) =>
    Object.values(CLOUD_CAPABILITY_ROUTES).includes(route.id)
      ? { ...route, state: "qualified" as const }
      : route,
  );
const desktop = (heartbeatMinutesAgo: number | null): HomeWorkerToken => ({
  id: "desk",
  workspaceId,
  name: "Desktop RX 6650 XT (WSL) + ASR",
  tokenHash: "h",
  prefix: "mmhw_x",
  capabilities: ["image_editing", "visual_qa", "copywriting", "speech_recognition"],
  createdById: "owner-1",
  createdAt: now,
  lastUsedAt: now,
  revokedAt: null,
  heartbeatAt:
    heartbeatMinutesAgo === null ? null : new Date(now.getTime() - heartbeatMinutesAgo * 60_000),
});
const all = new Set(["image_editing", "visual_qa", "copywriting"] as const);

describe("cloudCapabilities", () => {
  const healthy = () => ({ usable: true });

  it("serves nothing while routes are only candidates", () => {
    expect(
      cloudCapabilities({
        routes: DEFAULT_ROUTES,
        health: healthy,
        tokens: [desktop(60)],
        available: all,
        now,
      }),
    ).toEqual([]);
  });

  it("takes qualified capabilities only while the desktop is offline", () => {
    const routes = qualified(DEFAULT_ROUTES);
    expect(
      cloudCapabilities({ routes, health: healthy, tokens: [desktop(1)], available: all, now }),
    ).toEqual([]);
    expect(
      cloudCapabilities({ routes, health: healthy, tokens: [desktop(6)], available: all, now }),
    ).toEqual(["copywriting", "image_editing", "visual_qa"]);
    expect(
      cloudCapabilities({
        routes,
        health: healthy,
        tokens: [desktop(null)],
        available: new Set(["image_editing"]),
        now,
      }),
    ).toEqual(["image_editing"]);
  });

  it("runs routes in qualification too (production trial while the desktop is off)", () => {
    const routes = DEFAULT_ROUTES.map((route) =>
      route.id === CLOUD_CAPABILITY_ROUTES.visual_qa
        ? { ...route, state: "qualifying" as const }
        : route,
    );
    expect(
      cloudCapabilities({ routes, health: healthy, tokens: [desktop(30)], available: all, now }),
    ).toEqual(["visual_qa"]);
  });

  it("lets only a free cloud route take overflow from a busy online desktop", () => {
    const routes = qualified(DEFAULT_ROUTES);
    const backlog = (capability: string) => (capability === "image_editing" ? 4 : 9);
    // Workers AI scenes are free: they help. Gateway QA and copy are paid: the desktop keeps them.
    expect(
      cloudCapabilities({
        routes,
        health: healthy,
        tokens: [desktop(1)],
        available: all,
        backlog,
        now,
      }),
    ).toEqual(["image_editing"]);
    expect(
      cloudCapabilities({
        routes,
        health: healthy,
        tokens: [desktop(1)],
        available: all,
        backlog: () => 2,
        now,
      }),
    ).toEqual([]);
  });

  it("skips a cooling or exhausted cloud route", () => {
    const routes = qualified(DEFAULT_ROUTES);
    const health = (route: GenerationRoute) =>
      route.task === "vision.qa" ? { usable: false, reason: "cooling" as const } : { usable: true };
    expect(cloudCapabilities({ routes, health, tokens: [], available: all, now })).toEqual([
      "copywriting",
      "image_editing",
    ]);
  });
});

describe("createCloudWorker", () => {
  const harness = (desktopToken: HomeWorkerToken, routes: readonly GenerationRoute[]) => {
    const tokens: HomeWorkerToken[] = [desktopToken];
    const claims: string[] = [];
    const worker = createCloudWorker({
      workspaces: async () => [workspaceId],
      tokens: {
        create: async (token) => {
          tokens.push(token);
          return token;
        },
        listForWorkspace: async () => tokens,
        revoke: async ({ id, at }) => {
          const index = tokens.findIndex((token) => token.id === id);
          tokens[index] = { ...(tokens[index] as HomeWorkerToken), revokedAt: at };
          return tokens[index] ?? null;
        },
      },
      routes: { list: async () => routes, seed: async () => undefined, recentRuns: async () => [] },
      connections: { findAllForWorkspace: async () => [] },
      secrets: () => ({ get: async () => null }),
      workersAi: { accountId: "a", apiToken: "t" },
      apiUrl: new URL("https://api.test"),
      // Heartbeat and an empty claim (204): no network in tests.
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
      now: () => now,
    });
    return { worker, tokens, claims };
  };

  it("issues no token and claims nothing while the desktop is online", async () => {
    const { worker, tokens } = harness(desktop(1), qualified(DEFAULT_ROUTES));
    expect(await worker.round()).toBe(0);
    expect(tokens.filter((token) => token.name === CLOUD_WORKER_TOKEN_NAME)).toEqual([]);
  });

  it("issues its own token for the qualified capabilities when the desktop is off, and revokes it on stop", async () => {
    const { worker, tokens } = harness(desktop(30), qualified(DEFAULT_ROUTES));
    expect(await worker.round()).toBe(0); // nothing to claim
    const cloud = tokens.filter((token) => token.name === CLOUD_WORKER_TOKEN_NAME);
    expect(cloud).toHaveLength(1);
    expect(cloud[0]?.capabilities).toEqual(["image_editing"]);
    expect(cloud[0]?.createdById).toBe("owner-1");
    await worker.stop();
    expect(tokens.find((token) => token.name === CLOUD_WORKER_TOKEN_NAME)?.revokedAt).toEqual(now);
  });
});
