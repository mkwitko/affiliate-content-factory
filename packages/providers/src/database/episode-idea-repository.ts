import type { WorkspaceId } from "@money-maker/contracts";
import type {
  EpisodeIdea,
  EpisodeIdeaStatus,
  HookContract,
  IdeaScore,
  PackagingVariant,
  VariantChecks,
} from "@money-maker/core/youtube/episode-idea";
import type { EpisodeIdeaRepository } from "@money-maker/core/youtube/episode-idea-repository";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type Row = {
  id: string;
  workspaceId: string;
  nicheId: string;
  workingTitle: string;
  status: string;
  score: unknown;
  packaging: unknown;
  packagingChecks: unknown;
  selectedVariantId: string | null;
  hookContract: unknown;
  decisionNote: string | null;
  contentItemId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// The JSON columns are written only from validated EpisodeIdea values, so the casts restore
// the types Prisma erased.
export const episodeIdeaFromRow = (row: Row): EpisodeIdea => ({
  id: row.id,
  workspaceId: row.workspaceId as WorkspaceId,
  nicheId: row.nicheId,
  workingTitle: row.workingTitle,
  status: row.status as EpisodeIdeaStatus,
  score: row.score as IdeaScore,
  ...(row.packaging !== null ? { packaging: row.packaging as PackagingVariant[] } : {}),
  ...(row.packagingChecks !== null
    ? { packagingChecks: row.packagingChecks as VariantChecks[] }
    : {}),
  ...(row.selectedVariantId !== null
    ? { selectedVariantId: row.selectedVariantId as PackagingVariant["id"] }
    : {}),
  ...(row.hookContract !== null ? { hookContract: row.hookContract as HookContract } : {}),
  ...(row.decisionNote !== null ? { decisionNote: row.decisionNote } : {}),
  ...(row.contentItemId !== null ? { contentItemId: row.contentItemId } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const json = (value: unknown) => value as Prisma.InputJsonValue;
const mutable = (idea: EpisodeIdea) => ({
  status: idea.status,
  score: json(idea.score),
  packaging: idea.packaging ? json(idea.packaging) : Prisma.DbNull,
  packagingChecks: idea.packagingChecks ? json(idea.packagingChecks) : Prisma.DbNull,
  selectedVariantId: idea.selectedVariantId ?? null,
  hookContract: idea.hookContract ? json(idea.hookContract) : Prisma.DbNull,
  decisionNote: idea.decisionNote ?? null,
  contentItemId: idea.contentItemId ?? null,
  updatedAt: idea.updatedAt,
});

export class PrismaEpisodeIdeaRepository implements EpisodeIdeaRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createMany(ideas: readonly EpisodeIdea[]): Promise<void> {
    await this.client.episodeIdea.createMany({
      data: ideas.map((idea) => ({
        id: idea.id,
        workspaceId: idea.workspaceId,
        nicheId: idea.nicheId,
        workingTitle: idea.workingTitle,
        createdAt: idea.createdAt,
        ...mutable(idea),
      })),
    });
  }

  public async findForWorkspace(input: { workspaceId: WorkspaceId; ideaId: string }) {
    const row = await this.client.episodeIdea.findFirst({
      where: { id: input.ideaId, workspaceId: input.workspaceId },
    });
    return row ? episodeIdeaFromRow(row) : null;
  }

  public async listForNiche(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    status?: EpisodeIdeaStatus;
  }) {
    const rows = await this.client.episodeIdea.findMany({
      where: {
        workspaceId: input.workspaceId,
        nicheId: input.nicheId,
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return rows.map(episodeIdeaFromRow);
  }

  // ponytail: last write wins; add an updatedAt compare-and-set if two operators edit one idea.
  public async save(idea: EpisodeIdea): Promise<boolean> {
    const { count } = await this.client.episodeIdea.updateMany({
      where: { id: idea.id, workspaceId: idea.workspaceId },
      data: mutable(idea),
    });
    return count === 1;
  }
}
