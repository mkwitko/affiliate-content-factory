import { describe, expect, it } from "vitest";
import {
  type GenerationRoute,
  type GenerationRun,
  orderRoutes,
  ROUTE_COOLDOWN_MS,
  routeHealth,
  routeId,
} from "./routing.js";

const now = new Date("2026-10-14T15:00:00Z");
const route = (
  over: Partial<GenerationRoute> & Pick<GenerationRoute, "executor">,
): GenerationRoute => ({
  id: routeId("video.i2v", over.model ?? "wan", over.executor),
  task: "video.i2v",
  model: "wan",
  cost: "credit",
  provider: over.executor,
  state: "qualified",
  ownerRank: null,
  passCount: 0,
  runCount: 0,
  costPerUnitMinor: null,
  ...over,
});
const healthy = () => ({ usable: true });
const ids = (routes: readonly GenerationRoute[]) => routes.map((r) => r.executor);

describe("routeHealth", () => {
  const run = (
    outcome: GenerationRun["outcome"],
    minutesAgo: number,
    retryAfter?: Date,
  ): GenerationRun => ({
    routeId: "r",
    outcome,
    at: new Date(now.getTime() - minutesAgo * 60_000),
    ...(retryAfter ? { retryAfter } : {}),
  });

  it("cools a route after three technical failures in a row, then lets it back", () => {
    const runs = [
      run("technical_failure", 1),
      run("technical_failure", 2),
      run("technical_failure", 3),
    ];
    expect(routeHealth(runs, now)).toEqual({ usable: false, reason: "cooling" });
    expect(routeHealth(runs, new Date(now.getTime() + ROUTE_COOLDOWN_MS))).toEqual({
      usable: true,
    });
    expect(
      routeHealth([run("technical_failure", 1), run("ok", 2), run("technical_failure", 3)], now),
    ).toEqual({ usable: true });
  });

  it("treats quota exhaustion as a pause until retryAfter, never as a failure", () => {
    const later = new Date(now.getTime() + 3_600_000);
    expect(routeHealth([run("quota_exhausted", 1, later)], now)).toEqual({
      usable: false,
      reason: "quota_exhausted",
    });
    expect(routeHealth([run("quota_exhausted", 1, later)], later)).toEqual({ usable: true });
    const mixed = [
      run("technical_failure", 1),
      run("quota_exhausted", 2),
      run("technical_failure", 3),
    ];
    expect(routeHealth(mixed, now)).toEqual({ usable: true });
  });
});

describe("orderRoutes", () => {
  const base = {
    task: "video.i2v" as const,
    health: healthy,
    freeCreditLeft: () => true,
    paidAllowed: () => true,
  };

  it("puts free routes by owner rank first, then paid routes by cost", () => {
    const routes = [
      route({ executor: "paid-cheap", cost: "paid", costPerUnitMinor: 100 }),
      route({ executor: "free-unranked", cost: "always_free" }),
      route({ executor: "paid-dear", cost: "paid", costPerUnitMinor: 300 }),
      route({ executor: "credit-rank1", cost: "credit", ownerRank: 1 }),
      route({ executor: "free-rank2", cost: "always_free", ownerRank: 2 }),
    ];
    expect(ids(orderRoutes({ ...base, routes }))).toEqual([
      "credit-rank1",
      "free-rank2",
      "free-unranked",
      "paid-cheap",
      "paid-dear",
    ]);
  });

  it("moves a credit route behind the free ones once its credit is gone, and drops it without budget", () => {
    const routes = [
      route({ executor: "modal", cost: "credit", ownerRank: 1, costPerUnitMinor: 450 }),
      route({ executor: "desktop", cost: "always_free", ownerRank: 2 }),
    ];
    expect(ids(orderRoutes({ ...base, routes, freeCreditLeft: () => false }))).toEqual([
      "desktop",
      "modal",
    ]);
    expect(
      ids(orderRoutes({ ...base, routes, freeCreditLeft: () => false, paidAllowed: () => false })),
    ).toEqual(["desktop"]);
  });

  it("keeps only qualified, healthy routes of the task", () => {
    const routes = [
      route({ executor: "a", state: "candidate" }),
      route({ executor: "b", state: "demoted" }),
      route({ executor: "c" }),
      { ...route({ executor: "d" }), task: "llm.copy" as const },
      route({ executor: "e" }),
    ];
    const health = (r: GenerationRoute) =>
      r.executor === "e" ? { usable: false, reason: "offline" as const } : { usable: true };
    expect(ids(orderRoutes({ ...base, routes, health }))).toEqual(["c"]);
  });

  it("prefers the package's model on a tie, and the better pass rate after that", () => {
    const routes = [
      route({ executor: "x", model: "klein", ownerRank: 1, passCount: 9, runCount: 10 }),
      route({ executor: "y", model: "flux", ownerRank: 1, passCount: 5, runCount: 10 }),
      route({ executor: "z", model: "klein", ownerRank: 1, passCount: 3, runCount: 10 }),
    ];
    expect(ids(orderRoutes({ ...base, routes, packageModel: "flux" }))).toEqual(["y", "x", "z"]);
  });
});
