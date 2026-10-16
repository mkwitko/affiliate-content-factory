import { parseWorkspaceId } from "@money-maker/contracts";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import {
  type CandidateQualification,
  PRODUCT_CANDIDATE_STATES,
  type ProductCandidateState,
} from "@money-maker/core/research/product-candidate";
import type { ProductCandidateRepository } from "@money-maker/core/research/product-candidate-repository";
import type { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const toDomain = (record: {
  id: string;
  workspaceId: string;
  nicheId: string;
  policyId: string;
  providerId: string;
  title: string;
  listingUrl: string;
  seller: string;
  availability: string;
  priceMinor: number;
  currency: string;
  rank: number;
  bestSellerRank: number | null;
  discoveredAt: Date;
  state: string;
  offerId: string | null;
  qualifiedAt: Date | null;
  linkedAt: Date | null;
  qualification: unknown;
}): ProductCandidate =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    nicheId: record.nicheId,
    policyId: record.policyId,
    providerId: record.providerId,
    title: record.title,
    listingUrl: record.listingUrl,
    seller: record.seller,
    availability: record.availability,
    priceMinor: record.priceMinor,
    currency: record.currency,
    rank: record.rank,
    ...(record.bestSellerRank === null ? {} : { bestSellerRank: record.bestSellerRank }),
    discoveredAt: record.discoveredAt,
    state: record.state as ProductCandidateState,
    ...(record.offerId === null ? {} : { offerId: record.offerId }),
    ...(record.qualifiedAt === null ? {} : { qualifiedAt: record.qualifiedAt }),
    ...(record.linkedAt === null ? {} : { linkedAt: record.linkedAt }),
    ...(record.qualification === null || record.qualification === undefined
      ? {}
      : { qualification: record.qualification as CandidateQualification }),
  });

const MAX_QUEUE_SCAN = 1000;
const scoreOf = (candidate: ProductCandidate): number =>
  candidate.qualification?.heuristic.score ?? Number.NEGATIVE_INFINITY;

export class PrismaProductCandidateRepository implements ProductCandidateRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createMany(candidates: readonly ProductCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    await this.client.productCandidate.createMany({
      data: candidates.map((candidate) => ({
        id: candidate.id,
        workspaceId: candidate.workspaceId,
        nicheId: candidate.nicheId,
        policyId: candidate.policyId,
        providerId: candidate.providerId,
        title: candidate.title,
        listingUrl: candidate.listingUrl,
        seller: candidate.seller,
        availability: candidate.availability,
        priceMinor: candidate.priceMinor,
        currency: candidate.currency,
        rank: candidate.rank,
        ...(candidate.bestSellerRank !== undefined
          ? { bestSellerRank: candidate.bestSellerRank }
          : {}),
        discoveredAt: candidate.discoveredAt,
        state: candidate.state,
        ...(candidate.qualifiedAt ? { qualifiedAt: candidate.qualifiedAt } : {}),
        ...(candidate.qualification
          ? { qualification: candidate.qualification as unknown as Prisma.InputJsonValue }
          : {}),
      })),
    });
  }

  public async listForNiche(input: {
    workspaceId: ProductCandidate["workspaceId"];
    nicheId: string;
    since?: Date;
    take?: number;
  }): Promise<readonly ProductCandidate[]> {
    const take = Math.min(input.take ?? 50, 200);
    const records = await this.client.productCandidate.findMany({
      where: {
        workspaceId: input.workspaceId,
        nicheId: input.nicheId,
        ...(input.since ? { discoveredAt: { gte: input.since } } : {}),
      },
      orderBy: [{ discoveredAt: "desc" }, { rank: "asc" }],
      take,
    });
    return records.map(toDomain);
  }

  public async findForWorkspace(input: {
    workspaceId: ProductCandidate["workspaceId"];
    id: string;
  }): Promise<ProductCandidate | null> {
    const record = await this.client.productCandidate.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record) : null;
  }

  public async findByOffer(input: {
    workspaceId: ProductCandidate["workspaceId"];
    offerId: string;
  }): Promise<ProductCandidate | null> {
    const record = await this.client.productCandidate.findFirst({
      where: { offerId: input.offerId, workspaceId: input.workspaceId },
      orderBy: { discoveredAt: "desc" },
    });
    return record ? toDomain(record) : null;
  }

  public async listByState(input: {
    workspaceId: ProductCandidate["workspaceId"];
    nicheId?: string;
    states: readonly ProductCandidateState[];
    take?: number;
  }): Promise<readonly ProductCandidate[]> {
    const take = Math.min(input.take ?? 50, 200);
    // The score lives in JSON, so sort in memory over a bounded scan (open queues are small).
    const records = await this.client.productCandidate.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.nicheId ? { nicheId: input.nicheId } : {}),
        state: { in: [...input.states] },
      },
      orderBy: [{ discoveredAt: "desc" }],
      take: MAX_QUEUE_SCAN,
    });
    // Array.sort is stable, so equal scores keep the discoveredAt-desc order.
    return records
      .map(toDomain)
      .sort((a, b) => scoreOf(b) - scoreOf(a))
      .slice(0, take);
  }

  public async countByState(input: {
    workspaceId: ProductCandidate["workspaceId"];
    nicheId?: string;
  }): Promise<Readonly<Record<ProductCandidateState, number>>> {
    const groups = await this.client.productCandidate.groupBy({
      by: ["state"],
      where: {
        workspaceId: input.workspaceId,
        ...(input.nicheId ? { nicheId: input.nicheId } : {}),
      },
      _count: { _all: true },
    });
    const counts = Object.fromEntries(
      PRODUCT_CANDIDATE_STATES.map((state) => [state, 0]),
    ) as Record<ProductCandidateState, number>;
    for (const group of groups) counts[group.state as ProductCandidateState] = group._count._all;
    return Object.freeze(counts);
  }

  public async transition(input: {
    workspaceId: ProductCandidate["workspaceId"];
    id: string;
    from: readonly ProductCandidateState[];
    to: ProductCandidateState;
    at: Date;
    offerId?: string | null;
    qualification?: CandidateQualification;
  }): Promise<ProductCandidate | null> {
    const releasing = input.to === "awaiting_affiliate_link" && input.from.includes("linked");
    const result = await this.client.productCandidate.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, state: { in: [...input.from] } },
      data: {
        state: input.to,
        ...(input.to === "linked" ? { linkedAt: input.at } : {}),
        ...(input.to === "awaiting_affiliate_link"
          ? releasing
            ? { linkedAt: null }
            : { qualifiedAt: input.at }
          : {}),
        ...(input.offerId === undefined ? {} : { offerId: input.offerId }),
        ...(input.qualification
          ? { qualification: input.qualification as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
    if (result.count !== 1) return null;
    return this.findForWorkspace({ workspaceId: input.workspaceId, id: input.id });
  }
}
