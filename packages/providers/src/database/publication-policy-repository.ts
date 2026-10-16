import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createDefaultPublicationPolicy,
  type PublicationPolicy,
  type PublicationPolicyMode,
} from "@money-maker/core/workspaces/publication-policy";
import type { PublicationPolicyRepository } from "@money-maker/core/workspaces/publication-policy-repository";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const modeToDatabase = (mode: PublicationPolicyMode): "MANUAL" | "POLICY_BASED" | "PAUSED" =>
  mode.toUpperCase() as "MANUAL" | "POLICY_BASED" | "PAUSED";

const modeToDomain = (mode: "MANUAL" | "POLICY_BASED" | "PAUSED"): PublicationPolicyMode =>
  mode.toLowerCase() as PublicationPolicyMode;

const listKeys = [
  "allowedChannels",
  "allowedNiches",
  "allowedOffers",
  "allowedFormats",
  "allowedLanguages",
  "allowedClaimKeys",
] as const;

/** Stored JSON is untrusted: keep only string arrays and a positive integer evidence age. */
const readAllowLists = (value: unknown): Partial<PublicationPolicy> => {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of listKeys) {
    const list = record[key];
    if (Array.isArray(list) && list.every((entry) => typeof entry === "string"))
      out[key] = Object.freeze([...list]);
  }
  const age = record.evidenceMaxAgeDays;
  if (typeof age === "number" && Number.isInteger(age) && age > 0) out.evidenceMaxAgeDays = age;
  return out;
};
const writeAllowLists = (policy: PublicationPolicy) => {
  const out: Record<string, number | string[]> = {};
  for (const key of [...listKeys, "evidenceMaxAgeDays" as const]) {
    {
      const value = policy[key];
      if (value !== undefined) out[key] = typeof value === "number" ? value : [...value];
    }
  }
  return Object.keys(out).length ? out : Prisma.DbNull;
};

const toDomain = (record: {
  workspaceId: string;
  mode: "MANUAL" | "POLICY_BASED" | "PAUSED";
  version: number;
  maxPublicationsPerPeriod?: number | null;
  maxCostMinorPerItem?: number | null;
  maxCostMinorPerPeriod?: number | null;
  periodHours?: number | null;
  allowLists?: unknown;
}): PublicationPolicy =>
  Object.freeze({
    workspaceId: parseWorkspaceId(record.workspaceId),
    mode: modeToDomain(record.mode),
    version: record.version,
    ...(record.maxPublicationsPerPeriod === undefined || record.maxPublicationsPerPeriod === null
      ? {}
      : { maxPublicationsPerPeriod: record.maxPublicationsPerPeriod }),
    ...(record.maxCostMinorPerItem === undefined || record.maxCostMinorPerItem === null
      ? {}
      : { maxCostMinorPerItem: record.maxCostMinorPerItem }),
    ...(record.maxCostMinorPerPeriod === undefined || record.maxCostMinorPerPeriod === null
      ? {}
      : { maxCostMinorPerPeriod: record.maxCostMinorPerPeriod }),
    ...(record.periodHours === undefined || record.periodHours === null
      ? {}
      : { periodHours: record.periodHours }),
    ...readAllowLists(record.allowLists),
  });

export class PrismaPublicationPolicyRepository implements PublicationPolicyRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async findForWorkspace(
    workspaceId: PublicationPolicy["workspaceId"],
  ): Promise<PublicationPolicy> {
    const record = await this.client.publicationPolicy.findUnique({ where: { workspaceId } });
    if (record) return toDomain(record);
    return this.create(createDefaultPublicationPolicy(workspaceId));
  }

  public async create(policy: PublicationPolicy): Promise<PublicationPolicy> {
    const record = await this.client.publicationPolicy.create({
      data: {
        workspaceId: policy.workspaceId,
        mode: modeToDatabase(policy.mode),
        version: policy.version,
        maxPublicationsPerPeriod: policy.maxPublicationsPerPeriod ?? null,
        maxCostMinorPerItem: policy.maxCostMinorPerItem ?? null,
        maxCostMinorPerPeriod: policy.maxCostMinorPerPeriod ?? null,
        periodHours: policy.periodHours ?? null,
        allowLists: writeAllowLists(policy),
      },
    });
    return toDomain(record);
  }

  public async update(policy: PublicationPolicy): Promise<PublicationPolicy> {
    const record = await this.client.publicationPolicy.update({
      where: { workspaceId: policy.workspaceId },
      data: {
        mode: modeToDatabase(policy.mode),
        version: policy.version,
        maxPublicationsPerPeriod: policy.maxPublicationsPerPeriod ?? null,
        maxCostMinorPerItem: policy.maxCostMinorPerItem ?? null,
        maxCostMinorPerPeriod: policy.maxCostMinorPerPeriod ?? null,
        periodHours: policy.periodHours ?? null,
        allowLists: writeAllowLists(policy),
      },
    });
    return toDomain(record);
  }
}
