import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { ContentVariant } from "../content/content.js";
import type { FailedJob } from "../jobs/job-stats.js";
import type { ProductCandidate } from "../research/product-candidate.js";
import { fakeCandidateRepository } from "./test-support.js";
import { listHumanActions, type HumanActionDeps } from "./human-actions.js";
import { getAutonomyStatus, type AutonomyStatusDeps } from "./status.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-02T12:00:00Z");

const awaiting = (id: string): ProductCandidate => ({
  id,
  workspaceId,
  nicheId: "niche-1",
  policyId: "p",
  providerId: `MLB${id}`,
  title: `Produto ${id}`,
  listingUrl: `https://www.mercadolivre.com.br/p/MLB${id}`,
  seller: "s",
  availability: "available",
  priceMinor: 100,
  currency: "BRL",
  rank: 0,
  discoveredAt: now,
  state: "awaiting_affiliate_link",
});

const build = (input: {
  rows?: ProductCandidate[];
  variants?: Partial<ContentVariant>[];
  unknown?: string[];
  failed?: FailedJob[];
  assets?: { id: string }[];
}) => {
  const failed = input.failed ?? [];
  const variants = (input.variants ?? []) as ContentVariant[];
  const deps: AutonomyStatusDeps = {
    niches: {
      listForWorkspace: async () => [
        { id: "niche-1", name: "Casa", kind: "affiliate" } as never,
        { id: "niche-2", name: "Midia", kind: "media" } as never,
      ],
    },
    candidates: fakeCandidateRepository(input.rows ?? []),
    policies: {
      listForWorkspace: async () => [{ nicheId: "niche-1", targetPendingLinks: 5 } as never],
    },
    content: {
      listVariantsForWorkspace: async () => variants,
      findContentItemForWorkspace: async () => ({ title: "Post", nicheId: "niche-1" }) as never,
    },
    attempts: {
      listLatestForVariants: async () =>
        new Map(
          (input.unknown ?? []).map((variantId) => [
            variantId,
            {
              attemptId: `att-${variantId}`,
              status: "unknown_outcome",
              updatedAt: now,
            } as never,
          ]),
        ),
    },
    assets: { listForWorkspace: async () => (input.assets ?? []) as never },
    jobStats: {
      countByStatus: async () => [
        { name: "draft_offer_copy", status: "PENDING", count: 2 },
        { name: "direct_scenes", status: "RUNNING", count: 1 },
        { name: "draft_offer_copy", status: "COMPLETED", count: 9 },
        { name: "publish_content", status: "PENDING", count: 4 },
      ],
      listFailed: async () => failed,
    },
    homeTokens: {
      listForWorkspace: async () => [
        {
          name: "mac",
          lastUsedAt: now,
          revokedAt: null,
          heartbeatAt: new Date(now.getTime() - 60_000),
          heartbeat: {
            busy: "copywriting",
            runtimes: { copywriting: "healthy" },
            lastFailureCode: null,
          },
        } as never,
        {
          name: "old",
          lastUsedAt: null,
          revokedAt: null,
          heartbeatAt: new Date(now.getTime() - 3_600_000),
        } as never,
        { name: "revoked", revokedAt: now } as never,
      ],
    },
    affiliateLinkBuilderUrl: "https://builder.example/",
    generationPolicy: "local_first",
    autonomyEnabled: true,
  };
  return deps;
};

describe("listHumanActions", () => {
  it("lists affiliate links first with stable ids and refs", async () => {
    const deps = build({
      rows: [awaiting("a")],
      variants: [{ id: "v1", contentItemId: "i1", state: "ready_for_review" }],
      assets: [{ id: "as1" }],
      failed: [
        {
          id: "j1",
          name: "draft_offer_copy",
          idempotencyKey: "k",
          terminalReason: "x",
          updatedAt: now,
          attemptCount: 3,
        },
      ],
    });
    const first = await listHumanActions(deps, { workspaceId, limit: 20, now });
    expect(first.map((action) => action.id)).toEqual([
      "affiliate_link:a",
      "content_approval:v1",
      "asset_review:as1",
      "needs_attention:j1",
    ]);
    expect(first[0]).toMatchObject({
      nicheName: "Casa",
      refs: {
        candidateId: "a",
        affiliateLinkBuilderUrl: "https://builder.example/",
      },
    });
    expect(await listHumanActions(deps, { workspaceId, limit: 20, now })).toEqual(first);
  });

  it("surfaces unknown publication outcomes and drops resolved actions", async () => {
    const deps = build({
      variants: [{ id: "v1", contentItemId: "i1", state: "approved" }],
      unknown: ["v1"],
    });
    expect(
      (await listHumanActions(deps, { workspaceId, limit: 20, now })).map((action) => action.id),
    ).toEqual(["publication_unknown:att-v1"]);
    const resolved = build({
      variants: [{ id: "v1", contentItemId: "i1", state: "approved" }],
    });
    expect(await listHumanActions(resolved, { workspaceId, limit: 20, now })).toEqual([]);
  });

  it("honours the limit", async () => {
    const deps = build({ rows: [awaiting("a"), awaiting("b"), awaiting("c")] });
    expect(await listHumanActions(deps, { workspaceId, limit: 2, now })).toHaveLength(2);
  });
});

describe("getAutonomyStatus", () => {
  it("summarises candidates, jobs, local AI and attention", async () => {
    const deps = build({
      rows: [awaiting("a"), { ...awaiting("b"), state: "consumed" }],
      variants: [
        { id: "v1", contentItemId: "i1", state: "ready_for_review" },
        { id: "v2", contentItemId: "i2", state: "published" },
      ],
      failed: [
        {
          id: "j1",
          name: "produce_offer_package",
          idempotencyKey: "k",
          terminalReason: null,
          updatedAt: now,
          attemptCount: 6,
        },
      ],
    });
    const status = await getAutonomyStatus(deps, { workspaceId, now });
    expect(status.affiliate).toEqual([
      {
        nicheId: "niche-1",
        nicheName: "Casa",
        awaiting: 1,
        linked: 0,
        inProduction: 0,
        consumed: 1,
        target: 5,
      },
    ]);
    expect(status.production.variantsByState).toEqual({
      ready_for_review: 1,
      published: 1,
    });
    expect(status.localAi.queueDepth).toBe(3);
    expect(status.localAi.workers.map((worker) => [worker.name, worker.online])).toEqual([
      ["mac", true],
      ["old", false],
    ]);
    expect(status.localAi.workers[0]).toMatchObject({ busy: "copywriting" });
    expect(status.needsAttention).toEqual([
      {
        jobId: "j1",
        name: "produce_offer_package",
        reason: "unknown",
        at: now,
      },
    ]);
    expect(status.humanActions).toMatchObject({
      affiliate_link: 1,
      content_approval: 1,
      needs_attention: 1,
    });
    expect(status.generationPolicy).toBe("local_first");
    expect(status.autonomyEnabled).toBe(true);
  });
});
