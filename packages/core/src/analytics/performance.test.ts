import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  isMetricSyncDue,
  type MetricSyncCandidate,
  type PerformanceObservation,
  runDueMetricSyncs,
} from "./performance.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-30T12:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

describe("metric sync schedule", () => {
  it("reads metrics at 1, 3, 7 and 30 days, once each", () => {
    expect(isMetricSyncDue(daysAgo(0.5), 0, now)).toBe(false);
    expect(isMetricSyncDue(daysAgo(1), 0, now)).toBe(true);
    expect(isMetricSyncDue(daysAgo(2), 1, now)).toBe(false);
    expect(isMetricSyncDue(daysAgo(3), 1, now)).toBe(true);
    expect(isMetricSyncDue(daysAgo(10), 2, now)).toBe(true);
    expect(isMetricSyncDue(daysAgo(40), 4, now)).toBe(false);
  });
});

describe("runDueMetricSyncs", () => {
  const candidate = (overrides: Partial<MetricSyncCandidate> = {}): MetricSyncCandidate => ({
    workspaceId,
    publicationAttemptId: "pa1",
    contentVariantId: "v1",
    connectionId: "co1",
    externalId: "sp_1",
    publishedAt: daysAgo(1),
    observationCount: 0,
    ...overrides,
  });
  const run = (
    candidates: MetricSyncCandidate[],
    read: () => Promise<{ metrics: Record<string, number>; platformUrl?: string } | null>,
  ) => {
    const recorded: PerformanceObservation[] = [];
    const errors: unknown[] = [];
    return runDueMetricSyncs({
      performance: {
        listSyncCandidates: async () => candidates,
        record: async (observation) => {
          recorded.push(observation);
        },
        latestByVariant: async () => [],
        observationsAtCheckpoint: async () => [],
      },
      connections: {
        findForWorkspace: async () =>
          ({ id: "co1", secretReference: "ref", accountId: "acc" }) as never,
      },
      publisherForWorkspace: () => ({
        publish: async () => ({ externalId: "x", status: "published" as const }),
        reconcile: async () => ({ externalId: "x", status: "published" as const }),
        readMetrics: read,
      }),
      now: () => now,
      onError: (error) => errors.push(error),
    }).then(() => ({ recorded, errors }));
  };

  it("records the metrics of a post whose checkpoint passed, and skips one that is not due", async () => {
    const { recorded } = await run(
      [candidate(), candidate({ publicationAttemptId: "pa2", publishedAt: daysAgo(0.2) })],
      async () => ({
        metrics: { reach: 900, likes: 40 },
        platformUrl: "https://instagram.com/p/x",
      }),
    );
    expect(recorded).toEqual([
      {
        workspaceId,
        contentVariantId: "v1",
        publicationAttemptId: "pa1",
        observedAt: now,
        metrics: { reach: 900, likes: 40 },
        platformUrl: "https://instagram.com/p/x",
      },
    ]);
  });

  it("stores an empty observation when the provider has no metrics, so it is not retried", async () => {
    const { recorded } = await run([candidate()], async () => null);
    expect(recorded[0]?.metrics).toEqual({});
  });

  it("preserves YouTube watch metrics and their provider units at the normal checkpoint", async () => {
    const { recorded } = await run([candidate()], async () => ({
      metrics: {
        views: 20,
        estimatedMinutesWatched: 12,
        averageViewDurationSeconds: 36,
        averageViewPercentage: 42.5,
        subscribersGained: 2,
        subscribersLost: 1,
        engagedViews: 18,
      },
    }));
    expect(recorded[0]?.metrics).toEqual({
      views: 20,
      estimatedMinutesWatched: 12,
      averageViewDurationSeconds: 36,
      averageViewPercentage: 42.5,
      subscribersGained: 2,
      subscribersLost: 1,
      engagedViews: 18,
    });
  });

  it("records a refused key as an empty checkpoint instead of retrying every sweep", async () => {
    const { recorded, errors } = await run([candidate()], async () => {
      throw new Error("provider_credential_expired");
    });
    expect(recorded[0]?.metrics).toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("keeps going after one post fails", async () => {
    let calls = 0;
    const { recorded, errors } = await run(
      [candidate(), candidate({ publicationAttemptId: "pa2" })],
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider_rate_limited");
        return { metrics: { views: 10 } };
      },
    );
    expect(errors).toHaveLength(1);
    expect(recorded.map((entry) => entry.publicationAttemptId)).toEqual(["pa2"]);
  });
});
