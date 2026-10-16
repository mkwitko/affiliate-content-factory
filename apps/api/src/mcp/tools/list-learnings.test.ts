import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { CheckpointObservation } from "@money-maker/core/analytics/learnings";
import type { McpDependencies } from "../server.js";
import { listLearningsTool } from "./list-learnings.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const obs = (arm: string, shares: number): CheckpointObservation => ({
  contentVariantId: `v-${arm}-${shares}`,
  channelId: "c",
  channelKind: "instagram_reels",
  publishedAt: new Date("2026-09-20T15:00:00Z"),
  observedAt: new Date("2026-09-27T15:00:00Z"),
  metrics: { shares },
  creativeFeatures: { hookMove: arm },
  uniqueClicks: 0,
});
const deps = (rows: CheckpointObservation[], role = "reviewer") =>
  ({
    workspaces: {
      findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    },
    performanceRepository: { observationsAtCheckpoint: async () => rows },
  }) as unknown as McpDependencies;

describe("list_learnings", () => {
  it("separates learnings from insufficient data", async () => {
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => obs("contrast", 10 + (i % 2))),
      ...Array.from({ length: 11 }, (_, i) => obs("bold_claim", 30 + (i % 2))),
    ];
    const result = await listLearningsTool(
      { workspaceId, feature: "hookMove" },
      actorId,
      deps(rows),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        learnings: [{ feature: "hookMove", nA: 11, nB: 9, winner: "bold_claim" }],
        insufficientData: [],
      },
    });
    const thin = await listLearningsTool({ workspaceId }, actorId, deps(rows.slice(5, 14)));
    expect(thin).toMatchObject({ ok: true, value: { learnings: [] } });
  });
  it("rejects malformed input and non-members", async () => {
    await expect(
      listLearningsTool({ workspaceId, checkpointDays: 5 }, actorId, deps([])),
    ).resolves.toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    const outsider = {
      ...deps([]),
      workspaces: { findMembership: async () => null },
    } as unknown as McpDependencies;
    await expect(listLearningsTool({ workspaceId }, actorId, outsider)).resolves.toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});
