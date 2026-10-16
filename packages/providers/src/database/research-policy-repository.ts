import { parseWorkspaceId } from "@money-maker/contracts";
import type {
  ResearchPolicy,
  ResearchPolicyFrequency,
  ResearchPolicyStatus,
} from "@money-maker/core/research/research-policy";
import type { ResearchPolicyRepository } from "@money-maker/core/research/research-policy-repository";
import type { DatabaseClient } from "./client.js";

type DatabaseFrequency = "DAILY" | "WEEKLY";
type DatabaseStatus = "ACTIVE" | "PAUSED" | "REVOKED";

const frequencyToDatabase = (frequency: ResearchPolicyFrequency): DatabaseFrequency =>
  frequency.toUpperCase() as DatabaseFrequency;
const frequencyToDomain = (frequency: DatabaseFrequency): ResearchPolicyFrequency =>
  frequency.toLowerCase() as ResearchPolicyFrequency;
const statusToDatabase = (status: ResearchPolicyStatus): DatabaseStatus =>
  status.toUpperCase() as DatabaseStatus;
const statusToDomain = (status: DatabaseStatus): ResearchPolicyStatus =>
  status.toLowerCase() as ResearchPolicyStatus;

const toDomain = (record: {
  id: string;
  workspaceId: string;
  nicheId: string;
  frequency: DatabaseFrequency;
  maxCandidatesPerRun: number;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  currency: string | null;
  explicitQueries: string[];
  targetPendingLinks: number;
  status: DatabaseStatus;
  lastRunAt: Date | null;
  lastError: string | null;
  version: number;
}): ResearchPolicy =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    nicheId: record.nicheId,
    frequency: frequencyToDomain(record.frequency),
    maxCandidatesPerRun: record.maxCandidatesPerRun,
    ...(record.priceMinMinor === null ? {} : { priceMinMinor: record.priceMinMinor }),
    ...(record.priceMaxMinor === null ? {} : { priceMaxMinor: record.priceMaxMinor }),
    ...(record.currency === null ? {} : { currency: record.currency }),
    explicitQueries: Object.freeze([...record.explicitQueries]),
    targetPendingLinks: record.targetPendingLinks,
    status: statusToDomain(record.status),
    lastRunAt: record.lastRunAt,
    lastError: record.lastError,
    version: record.version,
  });

export class PrismaResearchPolicyRepository implements ResearchPolicyRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async create(policy: ResearchPolicy): Promise<ResearchPolicy> {
    const record = await this.client.researchPolicy.create({
      data: {
        id: policy.id,
        workspaceId: policy.workspaceId,
        nicheId: policy.nicheId,
        frequency: frequencyToDatabase(policy.frequency),
        maxCandidatesPerRun: policy.maxCandidatesPerRun,
        priceMinMinor: policy.priceMinMinor ?? null,
        priceMaxMinor: policy.priceMaxMinor ?? null,
        currency: policy.currency ?? null,
        explicitQueries: [...policy.explicitQueries],
        targetPendingLinks: policy.targetPendingLinks,
        status: statusToDatabase(policy.status),
        lastRunAt: policy.lastRunAt,
        lastError: policy.lastError,
        version: policy.version,
      },
    });
    return toDomain(record);
  }

  public async findForNiche(input: {
    workspaceId: ResearchPolicy["workspaceId"];
    nicheId: string;
  }): Promise<ResearchPolicy | null> {
    const record = await this.client.researchPolicy.findFirst({
      where: { workspaceId: input.workspaceId, nicheId: input.nicheId },
    });
    return record ? toDomain(record) : null;
  }

  public async listForWorkspace(
    workspaceId: ResearchPolicy["workspaceId"],
  ): Promise<readonly ResearchPolicy[]> {
    const records = await this.client.researchPolicy.findMany({ where: { workspaceId } });
    return records.map(toDomain);
  }

  public async update(policy: ResearchPolicy): Promise<ResearchPolicy> {
    const record = await this.client.researchPolicy.update({
      where: { workspaceId_nicheId: { workspaceId: policy.workspaceId, nicheId: policy.nicheId } },
      data: {
        frequency: frequencyToDatabase(policy.frequency),
        maxCandidatesPerRun: policy.maxCandidatesPerRun,
        priceMinMinor: policy.priceMinMinor ?? null,
        priceMaxMinor: policy.priceMaxMinor ?? null,
        currency: policy.currency ?? null,
        explicitQueries: [...policy.explicitQueries],
        targetPendingLinks: policy.targetPendingLinks,
        status: statusToDatabase(policy.status),
        lastRunAt: policy.lastRunAt,
        lastError: policy.lastError,
        version: policy.version,
      },
    });
    return toDomain(record);
  }

  public async listActiveDue(): Promise<readonly ResearchPolicy[]> {
    const records = await this.client.researchPolicy.findMany({ where: { status: "ACTIVE" } });
    return records.map(toDomain);
  }

  public async claimForRun(id: string, now: Date): Promise<boolean> {
    // "daily" is due once the calendar day (UTC) changes, so the boundary is the start of
    // today; "weekly" is due after 7 full days. Mirrors isResearchPolicyDue in core.
    const dailyBoundary = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const weeklyBoundary = new Date(now.getTime() - 7 * 86_400_000);
    const result = await this.client.researchPolicy.updateMany({
      where: {
        id,
        status: "ACTIVE",
        OR: [
          { lastRunAt: null },
          { frequency: "DAILY", lastRunAt: { lt: dailyBoundary } },
          { frequency: "WEEKLY", lastRunAt: { lt: weeklyBoundary } },
        ],
      },
      data: { lastRunAt: now },
    });
    return result.count === 1;
  }

  public async claimForTopUp(id: string, now: Date, minIntervalMs: number): Promise<boolean> {
    const result = await this.client.researchPolicy.updateMany({
      where: {
        id,
        status: "ACTIVE",
        OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - minIntervalMs) } }],
      },
      data: { lastRunAt: now },
    });
    return result.count === 1;
  }

  public async recordRunResult(id: string, lastError: string | null): Promise<void> {
    await this.client.researchPolicy.updateMany({
      where: { id, status: "ACTIVE" },
      data: { lastError },
    });
  }
}
