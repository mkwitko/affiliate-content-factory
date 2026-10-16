import { parseWorkspaceId } from "@money-maker/contracts";
import { DEFAULT_ROUTES } from "@money-maker/core/generation/route-repository";
import type { GenerationRoute, GenerationRun } from "@money-maker/core/generation/routing";
import { describe, expect, it } from "vitest";
import { clipRunOutcome, shadowChoice } from "./generation-shadow.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-14T15:00:00Z");
const modal = "video.i2v|wan2.2-i2v-a14b|modal";

const fakeRoutes = (runs: GenerationRun[] = []) => {
  let stored: GenerationRoute[] = [];
  return {
    list: async () => stored,
    seed: async (_: unknown, routes: readonly GenerationRoute[]) => {
      stored = [...routes];
    },
    recentRuns: async () => runs,
  };
};

describe("shadowChoice", () => {
  it("seeds today's routes on first use and agrees when the real run took the same route", async () => {
    expect(
      await shadowChoice(fakeRoutes(), { workspaceId, task: "video.i2v", actual: modal, now }),
    ).toEqual({ chosen: modal, actual: modal, agrees: true });
  });

  it("disagrees when the router would skip a cooling route", async () => {
    const failing = [1, 2, 3].map((minutes) => ({
      routeId: modal,
      outcome: "technical_failure" as const,
      at: new Date(now.getTime() - minutes * 60_000),
    }));
    expect(
      await shadowChoice(fakeRoutes(failing), {
        workspaceId,
        task: "video.i2v",
        actual: modal,
        now,
      }),
    ).toEqual({ chosen: null, actual: modal, agrees: false });
  });

  it("never throws when the run log is down", async () => {
    const broken = {
      list: async () => {
        throw new Error("db down");
      },
      seed: async () => undefined,
      recentRuns: async () => [],
    };
    expect(
      await shadowChoice(broken, { workspaceId, task: "video.i2v", actual: modal, now }),
    ).toEqual({ chosen: null, actual: modal, agrees: false });
  });

  it("only seeds the default routes", () => {
    expect(DEFAULT_ROUTES.some((route) => route.id === modal)).toBe(true);
  });
});

describe("clipRunOutcome", () => {
  it("tells passes, gate failures, budget pauses and technical failures apart", () => {
    expect(clipRunOutcome("ok", now)).toEqual({ outcome: "ok" });
    expect(clipRunOutcome("clip_check_failed:too_short", now)).toEqual({ outcome: "gate_failed" });
    expect(clipRunOutcome("budget_budget_exhausted", now)).toEqual({
      outcome: "quota_exhausted",
      retryAfter: new Date("2026-11-01T03:00:00.000Z"),
    });
    expect(clipRunOutcome("modal_timeout", now)).toEqual({ outcome: "technical_failure" });
  });
});
