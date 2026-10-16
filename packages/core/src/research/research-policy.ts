import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";

export type ResearchPolicyFrequency = "daily" | "weekly";
export type ResearchPolicyStatus = "active" | "paused" | "revoked";

export type ResearchPolicy = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  frequency: ResearchPolicyFrequency;
  maxCandidatesPerRun: number;
  priceMinMinor?: number;
  priceMaxMinor?: number;
  currency?: string;
  explicitQueries: readonly string[];
  /** Open affiliate-link slots the factory keeps filled per niche. */
  targetPendingLinks: number;
  status: ResearchPolicyStatus;
  lastRunAt: Date | null;
  lastError: string | null;
  version: number;
}>;

export type CreateResearchPolicyInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  frequency: ResearchPolicyFrequency;
  maxCandidatesPerRun: number;
  priceMinMinor?: number;
  priceMaxMinor?: number;
  currency?: string;
  explicitQueries?: readonly string[];
  targetPendingLinks?: number;
}>;

const MAX_CANDIDATES_PER_RUN = 20;
const MAX_TARGET_PENDING_LINKS = 20;
const DEFAULT_TARGET_PENDING_LINKS = 5;

export const createResearchPolicy = (input: CreateResearchPolicyInput): ResearchPolicy => {
  if (!input.nicheId.trim()) throw new Error("Research policy niche is required");
  if (
    !Number.isInteger(input.maxCandidatesPerRun) ||
    input.maxCandidatesPerRun < 1 ||
    input.maxCandidatesPerRun > MAX_CANDIDATES_PER_RUN
  ) {
    throw new Error(`Research policy maxCandidatesPerRun must be 1-${MAX_CANDIDATES_PER_RUN}`);
  }
  const targetPendingLinks = input.targetPendingLinks ?? DEFAULT_TARGET_PENDING_LINKS;
  if (
    !Number.isInteger(targetPendingLinks) ||
    targetPendingLinks < 0 ||
    targetPendingLinks > MAX_TARGET_PENDING_LINKS
  ) {
    throw new Error(`Research policy targetPendingLinks must be 0-${MAX_TARGET_PENDING_LINKS}`);
  }
  const hasPriceBound = input.priceMinMinor !== undefined || input.priceMaxMinor !== undefined;
  if (hasPriceBound && !input.currency?.trim()) {
    throw new Error("Research policy currency is required when a price bound is set");
  }
  if (
    input.priceMinMinor !== undefined &&
    input.priceMaxMinor !== undefined &&
    input.priceMinMinor > input.priceMaxMinor
  ) {
    throw new Error("Research policy priceMinMinor must not exceed priceMaxMinor");
  }
  const explicitQueries = (input.explicitQueries ?? [])
    .map((query) => query.trim())
    .filter(Boolean);
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    nicheId: input.nicheId,
    frequency: input.frequency,
    maxCandidatesPerRun: input.maxCandidatesPerRun,
    ...(input.priceMinMinor === undefined ? {} : { priceMinMinor: input.priceMinMinor }),
    ...(input.priceMaxMinor === undefined ? {} : { priceMaxMinor: input.priceMaxMinor }),
    ...(input.currency?.trim() ? { currency: input.currency.trim() } : {}),
    explicitQueries: Object.freeze(explicitQueries),
    targetPendingLinks,
    status: "active" as const,
    lastRunAt: null,
    lastError: null,
    version: 1,
  });
};

const changeStatus = (policy: ResearchPolicy, status: ResearchPolicyStatus): ResearchPolicy =>
  Object.freeze({ ...policy, status, version: policy.version + 1 });

export const pauseResearchPolicy = (policy: ResearchPolicy): ResearchPolicy =>
  changeStatus(policy, "paused");

export const revokeResearchPolicy = (policy: ResearchPolicy): ResearchPolicy =>
  changeStatus(policy, "revoked");

const DAY_MS = 86_400_000;
const dateKey = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * A policy is due once it has never run, or once enough time has passed since `lastRunAt`:
 * "daily" means a different UTC calendar day, "weekly" means at least 7 full days. A
 * paused/revoked policy is never due.
 */
export const isResearchPolicyDue = (policy: ResearchPolicy, now: Date): boolean => {
  if (policy.status !== "active") return false;
  if (!policy.lastRunAt) return true;
  if (policy.frequency === "daily") return dateKey(policy.lastRunAt) !== dateKey(now);
  return now.getTime() - policy.lastRunAt.getTime() >= 7 * DAY_MS;
};
