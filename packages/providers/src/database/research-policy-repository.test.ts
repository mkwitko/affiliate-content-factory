import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "./client.js";
import { PrismaResearchPolicyRepository } from "./research-policy-repository.js";

// Only the external Prisma query boundary is replaced; the where/data shape sent to Postgres is
// what matters for the claim-then-record contract (see run-research-policies.ts).
const clientFixture = (updateManyResult: { count: number }) => {
  const updateMany = vi.fn().mockResolvedValue(updateManyResult);
  const client = { researchPolicy: { updateMany } } as unknown as DatabaseClient;
  return { client, updateMany };
};

describe("PrismaResearchPolicyRepository.claimForRun", () => {
  it("returns true when exactly one ACTIVE-and-due row was claimed", async () => {
    const { client, updateMany } = clientFixture({ count: 1 });
    const repository = new PrismaResearchPolicyRepository(client);
    const now = new Date("2026-09-22T10:00:00Z");
    await expect(repository.claimForRun("policy-1", now)).resolves.toBe(true);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.data).toEqual({ lastRunAt: now });
    expect(call.where.id).toBe("policy-1");
    expect(call.where.status).toBe("ACTIVE");
    // due-or-never-run: null lastRunAt, or older than the frequency's due boundary
    expect(call.where.OR).toEqual(
      expect.arrayContaining([
        { lastRunAt: null },
        expect.objectContaining({ frequency: "DAILY" }),
        expect.objectContaining({ frequency: "WEEKLY" }),
      ]),
    );
  });

  it("returns false when no row matched (paused/revoked/not due/already claimed)", async () => {
    const { client } = clientFixture({ count: 0 });
    const repository = new PrismaResearchPolicyRepository(client);
    await expect(repository.claimForRun("policy-1", new Date())).resolves.toBe(false);
  });
});

describe("PrismaResearchPolicyRepository.claimForTopUp", () => {
  it("claims only an ACTIVE policy never run or last run before the interval", async () => {
    const { client, updateMany } = clientFixture({ count: 1 });
    const repository = new PrismaResearchPolicyRepository(client);
    const now = new Date("2026-09-22T10:00:00Z");
    await expect(repository.claimForTopUp("policy-1", now, 6 * 3_600_000)).resolves.toBe(true);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.data).toEqual({ lastRunAt: now });
    expect(call.where.status).toBe("ACTIVE");
    expect(call.where.OR).toEqual([
      { lastRunAt: null },
      { lastRunAt: { lt: new Date("2026-09-22T04:00:00Z") } },
    ]);
  });

  it("returns false when the policy ran recently or is not active", async () => {
    const { client } = clientFixture({ count: 0 });
    const repository = new PrismaResearchPolicyRepository(client);
    await expect(repository.claimForTopUp("policy-1", new Date(), 1000)).resolves.toBe(false);
  });
});

describe("PrismaResearchPolicyRepository.recordRunResult", () => {
  it("updates only lastError, scoped to ACTIVE, never status or version", async () => {
    const { client, updateMany } = clientFixture({ count: 1 });
    const repository = new PrismaResearchPolicyRepository(client);
    await repository.recordRunResult("policy-1", "RATE_LIMITED");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", status: "ACTIVE" },
      data: { lastError: "RATE_LIMITED" },
    });
  });

  it("clears lastError on success", async () => {
    const { client, updateMany } = clientFixture({ count: 1 });
    const repository = new PrismaResearchPolicyRepository(client);
    await repository.recordRunResult("policy-1", null);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "policy-1", status: "ACTIVE" },
      data: { lastError: null },
    });
  });
});
