import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { FailedJob } from "./job-stats.js";
import { listRetryableFailedJobs, retryFailedJob } from "./retry-failed-job.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const actorUserId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const now = new Date("2026-10-15T12:00:00Z");

const job = (id: string, name: string, identifiers: Record<string, string> = {}): FailedJob => ({
  id,
  name,
  idempotencyKey: id,
  terminalReason: "render_timeout",
  updatedAt: now,
  attemptCount: 2,
  identifiers,
});

const setup = (jobs: FailedJob[], revived = true) => {
  const events: unknown[] = [];
  return {
    events,
    deps: {
      jobStats: { listFailed: async () => jobs },
      jobQueue: { revive: async () => revived },
      audit: {
        record: async (event: unknown) => {
          events.push(event);
          return "a";
        },
      },
    },
  };
};

describe("retryFailedJob", () => {
  it("revives a retryable failed job and audits it", async () => {
    const { deps, events } = setup([job("j1", "render_reel")]);
    expect(await retryFailedJob(deps, { workspaceId, jobId: "j1", actorUserId, now })).toBe(
      "retried",
    );
    expect(events).toEqual([
      expect.objectContaining({
        action: "job.retried",
        metadata: { name: "render_reel", previousReason: "render_timeout" },
      }),
    ]);
  });

  it("refuses unknown, non-package and no-longer-failed jobs", async () => {
    expect(
      await retryFailedJob(setup([]).deps, { workspaceId, jobId: "j1", actorUserId, now }),
    ).toBe("not_found");
    expect(
      await retryFailedJob(setup([job("j1", "publish_content")]).deps, {
        workspaceId,
        jobId: "j1",
        actorUserId,
        now,
      }),
    ).toBe("not_retryable");
    const lost = setup([job("j1", "render_reel")], false);
    expect(await retryFailedJob(lost.deps, { workspaceId, jobId: "j1", actorUserId, now })).toBe(
      "not_retryable",
    );
    expect(lost.events).toEqual([]);
  });
});

describe("listRetryableFailedJobs", () => {
  it("keeps package steps only and resolves titles from the item or offer", async () => {
    const jobs = [
      job("a", "draft_offer_copy", { contentItemId: "c1" }),
      job("b", "produce_offer_package", { offerId: "o1" }),
      job("c", "publish_content", { attemptId: "x" }),
      job("d", "render_reel", { sourceVariantId: "v1" }),
    ];
    const listed = await listRetryableFailedJobs(
      {
        jobStats: { listFailed: async () => jobs },
        content: {
          findContentItemForWorkspace: async () => ({ title: "Panela" }) as never,
          findVariantForWorkspace: async () => ({ contentItemId: "c2" }) as never,
        },
        offers: { findForWorkspace: async () => ({ title: "Oferta" }) as never },
      },
      { workspaceId, now },
    );
    expect(listed.map((entry) => [entry.jobId, entry.title, entry.contentItemId])).toEqual([
      ["a", "Panela", "c1"],
      ["b", "Oferta", null],
      ["d", "Panela", "c2"],
    ]);
  });
});
