import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createInMemoryGenerationBudgetLedger } from "@money-maker/core/costs/generation-budget";
import type { GenerationRoute, GenerationRun } from "@money-maker/core/generation/routing";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { getGenerationRoutesTool, setGenerationRouteTool } from "./generation-routes.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const modal = "video.i2v|wan2.2-i2v-a14b|modal";

const deps = (options: { runs?: GenerationRun[]; role?: "owner" | "reviewer" | null } = {}) => {
  let stored: GenerationRoute[] = [];
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "W" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
    findMembership: async () =>
      options.role === null
        ? null
        : { workspaceId, userId: actorId, role: options.role ?? "reviewer", status: "active" },
    addMembership: async () => undefined,
  };
  return {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces,
    generationRoutes: {
      list: async () => stored,
      seed: async (_: unknown, routes: readonly GenerationRoute[]) => {
        stored = [...routes];
      },
      recordRun: async () => undefined,
      update: async (
        _: unknown,
        id: string,
        patch: { state?: GenerationRoute["state"]; ownerRank?: number | null },
      ) => {
        const index = stored.findIndex((route) => route.id === id);
        if (index < 0) return null;
        stored[index] = { ...(stored[index] as GenerationRoute), ...patch };
        return stored[index] ?? null;
      },
      recentRuns: async () => options.runs ?? [],
    },
    generationSettings: {
      get: async () => ({
        monthlyCapMinor: 10_000,
        freeCredits: { modal: { amountMinor: 2_990, currency: "USD" as const } },
      }),
      put: async () => undefined,
    },
    generationBudgetLedger: createInMemoryGenerationBudgetLedger(),
  } as unknown as McpDependencies;
};

type Value = {
  tasks: { task: string; order: { id: string }[]; excluded: { id: string; reason: string }[] }[];
};

describe("set_generation_route", () => {
  const cloudQa = "vision.qa|vercel:alibaba/qwen3-vl-instruct|cloud_worker";

  it("lets the owner put a cloud route in qualification", async () => {
    const d = deps({ role: "owner" });
    expect(
      await setGenerationRouteTool(
        { workspaceId, routeId: cloudQa, state: "qualifying" },
        actorId,
        d,
      ),
    ).toEqual({
      ok: true,
      value: { route: { id: cloudQa, state: "qualifying", ownerRank: null } },
    });
  });

  it("refuses a non-owner, an unknown route and an empty change", async () => {
    expect(
      await setGenerationRouteTool(
        { workspaceId, routeId: cloudQa, state: "qualified" },
        actorId,
        deps(),
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(
      await setGenerationRouteTool(
        { workspaceId, routeId: "x|y|z", state: "qualified" },
        actorId,
        deps({ role: "owner" }),
      ),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(
      await setGenerationRouteTool(
        { workspaceId, routeId: cloudQa },
        actorId,
        deps({ role: "owner" }),
      ),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});

describe("get_generation_routes", () => {
  it("seeds today's routes and shows each task's order", async () => {
    const result = await getGenerationRoutesTool({ workspaceId }, actorId, deps());
    const value = (result as { ok: true; value: Value }).value;
    expect(value.tasks.find((t) => t.task === "video.i2v")?.order.map((r) => r.id)).toEqual([
      modal,
    ]);
    expect(value.tasks.find((t) => t.task === "asr.ptbr")?.order).toHaveLength(1);
  });

  it("explains a route left out because it is cooling after failures", async () => {
    const now = Date.now();
    const runs = [1, 2, 3].map((minutes) => ({
      routeId: modal,
      outcome: "technical_failure" as const,
      at: new Date(now - minutes * 60_000),
    }));
    const result = await getGenerationRoutesTool({ workspaceId }, actorId, deps({ runs }));
    const clips = (result as { ok: true; value: Value }).value.tasks.find(
      (t) => t.task === "video.i2v",
    );
    expect(clips?.order).toEqual([]);
    expect(clips?.excluded).toEqual([{ id: modal, reason: "cooling", passRate: null, runs30d: 0 }]);
  });

  it("refuses a non-member", async () => {
    expect(await getGenerationRoutesTool({ workspaceId }, actorId, deps({ role: null }))).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});
