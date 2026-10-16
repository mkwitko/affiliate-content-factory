import type { AutonomyCycleDeps } from "@money-maker/core/autonomy/cycle";
import { describe, expect, it, vi } from "vitest";
import { autonomyLoops, autonomyTick } from "./autonomy-loop.js";

const emptyDeps = (workspaceIds: string[]) =>
  ({
    policies: {
      listForWorkspace: async () => [],
      listActiveDue: async () =>
        workspaceIds.map((workspaceId) => ({ workspaceId, status: "active" })),
    },
    niches: { listForWorkspace: async () => [] },
    candidates: { listByState: async () => [], countByState: async () => ({}) },
    offers: {},
    postingHistory: {},
    content: { listVariantsForWorkspace: async () => [] },
    jobs: {},
    marketplaceCatalogForWorkspace: () => ({}),
  }) as unknown as AutonomyCycleDeps;

describe("autonomy loop", () => {
  const createLoop = vi.fn(() => ({
    requestStop: () => {},
    run: async () => {},
  }));

  it("is off by default and off outside the full profile", () => {
    expect(
      autonomyLoops({
        enabled: false,
        profile: "full",
        deps: emptyDeps([]),
        createLoop,
      }),
    ).toEqual([]);
    expect(
      autonomyLoops({
        enabled: true,
        profile: "render_only",
        deps: emptyDeps([]),
        createLoop,
      }),
    ).toEqual([]);
    expect(createLoop).not.toHaveBeenCalled();
  });

  it("creates one 15 minute loop when enabled on the full profile", () => {
    expect(
      autonomyLoops({
        enabled: true,
        profile: "full",
        deps: emptyDeps([]),
        createLoop,
      }),
    ).toHaveLength(1);
    expect(createLoop).toHaveBeenCalledWith(expect.objectContaining({ intervalMs: 900_000 }));
  });

  it("runs once per workspace with an active policy and logs counters only", async () => {
    const log = vi.fn();
    const id = "0d7702aa-a69d-4f49-842a-c1a13e72160d";
    await autonomyTick(emptyDeps([id, id]), () => new Date("2026-10-02T12:00:00Z"), log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[1]).toMatchObject({
      workspaceId: id,
      qualified: 0,
      errors: [],
    });
  });
});
