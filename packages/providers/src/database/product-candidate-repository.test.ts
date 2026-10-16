import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { DatabaseClient } from "./client.js";
import { PrismaProductCandidateRepository } from "./product-candidate-repository.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const clientFixture = () => {
  const findMany = vi.fn().mockResolvedValue([]);
  const client = { productCandidate: { findMany } } as unknown as DatabaseClient;
  return { client, findMany };
};

describe("PrismaProductCandidateRepository.listForNiche", () => {
  it("defaults take to 50 and orders newest run first, then rank", async () => {
    const { client, findMany } = clientFixture();
    const repository = new PrismaProductCandidateRepository(client);
    await repository.listForNiche({ workspaceId, nicheId: "niche-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        orderBy: [{ discoveredAt: "desc" }, { rank: "asc" }],
      }),
    );
  });

  it("clamps a requested take to the 200 max", async () => {
    const { client, findMany } = clientFixture();
    const repository = new PrismaProductCandidateRepository(client);
    await repository.listForNiche({ workspaceId, nicheId: "niche-1", take: 5000 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });

  it("passes through a valid requested take", async () => {
    const { client, findMany } = clientFixture();
    const repository = new PrismaProductCandidateRepository(client);
    await repository.listForNiche({ workspaceId, nicheId: "niche-1", take: 10 });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });
});

const record = {
  id: "c-1",
  workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d",
  nicheId: "niche-1",
  policyId: "policy-1",
  providerId: "MLB1",
  title: "Produto",
  listingUrl: "https://produto.mercadolivre.com.br/MLB-1",
  seller: "Loja",
  availability: "available",
  priceMinor: 1000,
  currency: "BRL",
  rank: 0,
  discoveredAt: new Date("2026-10-02T00:00:00Z"),
  state: "linked",
  offerId: "offer-1",
  qualifiedAt: null,
  linkedAt: new Date("2026-10-02T01:00:00Z"),
  qualification: null,
};

describe("PrismaProductCandidateRepository lifecycle", () => {
  it("findForWorkspace filters by workspace and maps lifecycle fields", async () => {
    const findFirst = vi.fn().mockResolvedValue(record);
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { findFirst },
    } as unknown as DatabaseClient);
    const found = await repository.findForWorkspace({ workspaceId, id: "c-1" });
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "c-1", workspaceId } });
    expect(found).toMatchObject({ state: "linked", offerId: "offer-1" });
    expect(found).not.toHaveProperty("qualification");
  });

  it("listByState scopes by workspace/state and orders by score then recency", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { findMany },
    } as unknown as DatabaseClient);
    await repository.listByState({
      workspaceId,
      nicheId: "niche-1",
      states: ["awaiting_affiliate_link"],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        nicheId: "niche-1",
        state: { in: ["awaiting_affiliate_link"] },
      },
      orderBy: [{ discoveredAt: "desc" }],
      take: 1000,
    });
  });

  it("listByState sorts by heuristic score desc before recency", async () => {
    const at = (score: number | null, id: string) => ({
      ...record,
      id,
      qualification: score === null ? null : { heuristic: { score } },
    });
    const findMany = vi.fn().mockResolvedValue([at(10, "low"), at(null, "none"), at(50, "high")]);
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { findMany },
    } as unknown as DatabaseClient);
    const rows = await repository.listByState({
      workspaceId,
      states: ["awaiting_affiliate_link"],
      take: 2,
    });
    expect(rows.map((row) => row.id)).toEqual(["high", "low"]);
  });

  it("countByState returns zero for absent states", async () => {
    const groupBy = vi.fn().mockResolvedValue([{ state: "linked", _count: { _all: 3 } }]);
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { groupBy },
    } as unknown as DatabaseClient);
    const counts = await repository.countByState({ workspaceId });
    expect(counts.linked).toBe(3);
    expect(counts.consumed).toBe(0);
  });

  it("transition updates only rows in `from` and returns null on a lost race", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const findFirst = vi.fn();
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { updateMany, findFirst },
    } as unknown as DatabaseClient);
    const at = new Date("2026-10-02T02:00:00Z");
    const result = await repository.transition({
      workspaceId,
      id: "c-1",
      from: ["awaiting_affiliate_link"],
      to: "linked",
      at,
    });
    expect(result).toBeNull();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", workspaceId, state: { in: ["awaiting_affiliate_link"] } },
      data: { state: "linked", linkedAt: at },
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("transition rereads the row after a successful update", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findFirst = vi.fn().mockResolvedValue(record);
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { updateMany, findFirst },
    } as unknown as DatabaseClient);
    const at = new Date("2026-10-02T02:00:00Z");
    const result = await repository.transition({
      workspaceId,
      id: "c-1",
      from: ["linked"],
      to: "linked",
      at,
      offerId: "offer-1",
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", workspaceId, state: { in: ["linked"] } },
      data: { state: "linked", linkedAt: at, offerId: "offer-1" },
    });
    expect(result?.offerId).toBe("offer-1");
  });

  it("transition to awaiting stamps qualifiedAt, release clears linkedAt and offerId", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const repository = new PrismaProductCandidateRepository({
      productCandidate: { updateMany },
    } as unknown as DatabaseClient);
    const at = new Date("2026-10-02T02:00:00Z");
    await repository.transition({
      workspaceId,
      id: "c-1",
      from: ["discovered"],
      to: "awaiting_affiliate_link",
      at,
    });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { state: "awaiting_affiliate_link", qualifiedAt: at } }),
    );
    await repository.transition({
      workspaceId,
      id: "c-1",
      from: ["linked"],
      to: "awaiting_affiliate_link",
      at,
      offerId: null,
    });
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { state: "awaiting_affiliate_link", linkedAt: null, offerId: null },
      }),
    );
  });
});
