import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type {
  ResearchProvider,
  ResearchSnapshot,
} from "@money-maker/core/research/research-snapshot";
import type { DatabaseClient } from "./client.js";

type DatabaseResearchProvider = "VIDIQ" | "HOOK_LAYER" | "MERCADO_LIVRE" | "MANUAL";

const toDomain = (record: {
  id: string;
  workspaceId: string;
  nicheId: string | null;
  provider: DatabaseResearchProvider;
  query: string;
  locale: string;
  observedAt: Date;
  expiresAt: Date;
  contentHash: string;
  actorId: string;
  observations: Array<{ id: string; key: string; value: string; sourceUrl: string }>;
}): ResearchSnapshot =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    nicheId: record.nicheId,
    provider: record.provider.toLowerCase() as ResearchProvider,
    query: record.query,
    locale: record.locale,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    contentHash: record.contentHash,
    actorId: parseUserId(record.actorId),
    observations: Object.freeze(
      record.observations.map((observation) => Object.freeze(observation)),
    ),
  });

export class PrismaResearchRepository implements ResearchRepository {
  public constructor(private readonly client: DatabaseClient) {}
  public async create(snapshot: ResearchSnapshot): Promise<ResearchSnapshot> {
    const record = await this.client.researchSnapshot.create({
      data: {
        id: snapshot.id,
        workspaceId: snapshot.workspaceId,
        nicheId: snapshot.nicheId,
        provider: snapshot.provider.toUpperCase() as DatabaseResearchProvider,
        query: snapshot.query,
        locale: snapshot.locale,
        observedAt: snapshot.observedAt,
        expiresAt: snapshot.expiresAt,
        contentHash: snapshot.contentHash,
        actorId: snapshot.actorId,
        observations: {
          create: snapshot.observations.map((observation) => ({
            id: observation.id,
            key: observation.key,
            value: observation.value,
            sourceUrl: observation.sourceUrl,
          })),
        },
      },
      include: { observations: { orderBy: { key: "asc" } } },
    });
    return toDomain(record);
  }
  public async findByHash(input: {
    workspaceId: ResearchSnapshot["workspaceId"];
    hash: string;
  }): Promise<ResearchSnapshot | null> {
    const record = await this.client.researchSnapshot.findFirst({
      where: { workspaceId: input.workspaceId, contentHash: input.hash },
      include: { observations: { orderBy: { key: "asc" } } },
    });
    return record ? toDomain(record) : null;
  }
  public async findActiveForNiche(input: {
    workspaceId: ResearchSnapshot["workspaceId"];
    nicheId: string;
    now: Date;
  }): Promise<readonly ResearchSnapshot[]> {
    const records = await this.client.researchSnapshot.findMany({
      where: {
        workspaceId: input.workspaceId,
        nicheId: input.nicheId,
        expiresAt: { gt: input.now },
      },
      include: { observations: { orderBy: { key: "asc" } } },
      orderBy: { observedAt: "desc" },
    });
    return records.map(toDomain);
  }
  public async listForWorkspace(
    workspaceId: ResearchSnapshot["workspaceId"],
  ): Promise<readonly ResearchSnapshot[]> {
    const records = await this.client.researchSnapshot.findMany({
      where: { workspaceId },
      include: { observations: { orderBy: { key: "asc" } } },
      orderBy: { observedAt: "desc" },
    });
    return records.map(toDomain);
  }
  public async findObservationForWorkspace(input: {
    workspaceId: ResearchSnapshot["workspaceId"];
    observationId: string;
  }) {
    const record = await this.client.researchObservation.findFirst({
      where: { id: input.observationId, snapshot: { workspaceId: input.workspaceId } },
      include: { snapshot: { select: { id: true, expiresAt: true } } },
    });
    return record
      ? {
          id: record.id,
          snapshotId: record.snapshot.id,
          key: record.key,
          value: record.value,
          sourceUrl: record.sourceUrl,
          expiresAt: record.snapshot.expiresAt,
        }
      : null;
  }
}
