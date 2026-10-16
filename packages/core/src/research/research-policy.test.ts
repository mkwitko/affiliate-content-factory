import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createResearchPolicy,
  isResearchPolicyDue,
  pauseResearchPolicy,
  revokeResearchPolicy,
} from "./research-policy.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

describe("createResearchPolicy", () => {
  it("creates an active policy with defaults", () => {
    const policy = createResearchPolicy({
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 10,
    });
    expect(policy).toMatchObject({
      status: "active",
      version: 1,
      lastRunAt: null,
      lastError: null,
      explicitQueries: [],
    });
  });

  it("defaults targetPendingLinks to 5 and rejects values outside 0-20", () => {
    const base = {
      workspaceId,
      nicheId: "niche-1",
      frequency: "daily",
      maxCandidatesPerRun: 10,
    } as const;
    expect(createResearchPolicy(base).targetPendingLinks).toBe(5);
    expect(createResearchPolicy({ ...base, targetPendingLinks: 0 }).targetPendingLinks).toBe(0);
    expect(() => createResearchPolicy({ ...base, targetPendingLinks: 21 })).toThrow();
    expect(() => createResearchPolicy({ ...base, targetPendingLinks: -1 })).toThrow();
    expect(() => createResearchPolicy({ ...base, targetPendingLinks: 1.5 })).toThrow();
  });

  it("rejects maxCandidatesPerRun above 20", () => {
    expect(() =>
      createResearchPolicy({
        workspaceId,
        nicheId: "niche-1",
        frequency: "daily",
        maxCandidatesPerRun: 21,
      }),
    ).toThrow();
  });

  it("rejects a price bound without a currency", () => {
    expect(() =>
      createResearchPolicy({
        workspaceId,
        nicheId: "niche-1",
        frequency: "daily",
        maxCandidatesPerRun: 5,
        priceMinMinor: 1000,
      }),
    ).toThrow();
  });

  it("rejects priceMinMinor greater than priceMaxMinor", () => {
    expect(() =>
      createResearchPolicy({
        workspaceId,
        nicheId: "niche-1",
        frequency: "daily",
        maxCandidatesPerRun: 5,
        priceMinMinor: 2000,
        priceMaxMinor: 1000,
        currency: "BRL",
      }),
    ).toThrow();
  });
});

describe("pauseResearchPolicy / revokeResearchPolicy", () => {
  const policy = createResearchPolicy({
    workspaceId,
    nicheId: "niche-1",
    frequency: "daily",
    maxCandidatesPerRun: 5,
  });

  it("pauses and bumps the version", () => {
    const paused = pauseResearchPolicy(policy);
    expect(paused).toMatchObject({ status: "paused", version: 2 });
  });

  it("revokes and bumps the version", () => {
    const revoked = revokeResearchPolicy(policy);
    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
  });
});

describe("isResearchPolicyDue", () => {
  const base = createResearchPolicy({
    workspaceId,
    nicheId: "niche-1",
    frequency: "daily",
    maxCandidatesPerRun: 5,
  });

  it("is due when it has never run", () => {
    expect(isResearchPolicyDue(base, new Date("2026-09-22T10:00:00Z"))).toBe(true);
  });

  it("a daily policy is not due again on the same UTC day", () => {
    const ranEarlierToday = { ...base, lastRunAt: new Date("2026-09-22T02:00:00Z") };
    expect(isResearchPolicyDue(ranEarlierToday, new Date("2026-09-22T10:00:00Z"))).toBe(false);
  });

  it("a daily policy is due the next UTC day", () => {
    const ranYesterday = { ...base, lastRunAt: new Date("2026-09-21T23:00:00Z") };
    expect(isResearchPolicyDue(ranYesterday, new Date("2026-09-22T00:30:00Z"))).toBe(true);
  });

  it("a weekly policy is not due before 7 days pass", () => {
    const weekly = {
      ...base,
      frequency: "weekly" as const,
      lastRunAt: new Date("2026-09-20T00:00:00Z"),
    };
    expect(isResearchPolicyDue(weekly, new Date("2026-09-22T00:00:00Z"))).toBe(false);
  });

  it("a weekly policy is due after 7 days", () => {
    const weekly = {
      ...base,
      frequency: "weekly" as const,
      lastRunAt: new Date("2026-09-14T00:00:00Z"),
    };
    expect(isResearchPolicyDue(weekly, new Date("2026-09-22T00:00:00Z"))).toBe(true);
  });

  it("a paused or revoked policy is never due", () => {
    expect(
      isResearchPolicyDue({ ...base, status: "paused" }, new Date("2027-01-01T00:00:00Z")),
    ).toBe(false);
    expect(
      isResearchPolicyDue({ ...base, status: "revoked" }, new Date("2027-01-01T00:00:00Z")),
    ).toBe(false);
  });
});
