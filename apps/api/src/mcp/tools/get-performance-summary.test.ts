import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { getPerformanceSummaryTool } from "./get-performance-summary.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const dependencies = (role: "owner" | "reviewer" | "operator" = "reviewer") =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {},
    workspaces: {
      findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    },
    performanceRepository: {
      latestByVariant: async () => [
        {
          workspaceId,
          contentVariantId: "v1",
          publicationAttemptId: "pa1",
          observedAt: new Date("2026-09-23T10:00:00Z"),
          metrics: { reach: 1000, likes: 40 },
          creativeFeatures: { hookMove: "contrast" },
          channelId: "ch1",
          publishedAt: new Date("2026-09-20T10:00:00Z"),
        },
        {
          workspaceId,
          contentVariantId: "v2",
          publicationAttemptId: "pa2",
          observedAt: new Date("2026-09-23T10:00:00Z"),
          metrics: {},
          channelId: "ch2",
          publishedAt: null,
        },
      ],
    },
    attributionRepository: {
      summary: async () => [{ key: "v1", clicks: 30, uniqueClicks: 25, lastClickAt: new Date() }],
    },
  }) as unknown as McpDependencies;

describe("get_performance_summary", () => {
  it("joins each post's latest metrics with its clicks and a calculated click rate", async () => {
    const result = await getPerformanceSummaryTool({ workspaceId }, actorId, dependencies());
    expect(result).toMatchObject({
      ok: true,
      value: {
        posts: [
          { contentVariantId: "v1", clicks: 30, uniqueClicks: 25, clickRate: 0.025 },
          { contentVariantId: "v2", clicks: 0, uniqueClicks: 0, clickRate: null, metrics: {} },
        ],
        // One-post patterns say nothing yet: counted, not listed (agents read this tool).
        creativePatterns: [],
        insufficientPatterns: 1,
      },
    });
  });

  it("groups by a creative feature, skipping missing metrics instead of averaging zeros", async () => {
    const base = dependencies();
    const post = (id: string, arm: string, metrics: Record<string, number>) => ({
      workspaceId,
      contentVariantId: id,
      publicationAttemptId: `pa-${id}`,
      observedAt: new Date("2026-09-23T10:00:00Z"),
      metrics,
      channelId: "ch1",
      publishedAt: new Date("2026-09-20T10:00:00Z"),
      creativeFeatures: { hookMove: arm },
    });
    const deps = {
      ...base,
      performanceRepository: {
        latestByVariant: async () => [
          post("a1", "contrast", { shares: 10 }),
          post("a2", "contrast", { shares: 20 }),
          post("a3", "contrast", {}),
          post("b1", "bold_claim", { shares: 5 }),
        ],
      },
    } as unknown as McpDependencies;
    const result = await getPerformanceSummaryTool(
      { workspaceId, groupBy: "hookMove" },
      actorId,
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        groupBy: "hookMove",
        groups: [
          { arm: "contrast", metrics: { shares: { mean: 15, n: 2 } } },
          { arm: "bold_claim", metrics: { shares: { mean: 5, n: 1 } } },
        ],
      },
    });
  });

  it("rejects malformed input", async () => {
    await expect(
      getPerformanceSummaryTool({ workspaceId, since: "yesterday" }, actorId, dependencies()),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const outsider = {
      ...dependencies(),
      workspaces: { findMembership: async () => null },
    } as unknown as McpDependencies;
    await expect(getPerformanceSummaryTool({ workspaceId }, actorId, outsider)).resolves.toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});
