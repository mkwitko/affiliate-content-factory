import type { ContinuityRepository } from "@money-maker/core/story/continuity";
import type { ContinuityFact } from "@money-maker/core/story/story";
import type { DatabaseClient } from "./client.js";

export const continuityFactFromRow = (row: {
  factId: string;
  episodeId: string;
  kind: string;
  subject: string;
  predicate: string;
  object: string | null;
  salience: number;
  supersedes: string | null;
  expiresEpisode: number | null;
}): ContinuityFact => ({
  id: row.factId,
  episodeId: row.episodeId,
  kind: row.kind as ContinuityFact["kind"],
  subject: row.subject,
  predicate: row.predicate,
  ...(row.object !== null ? { object: row.object } : {}),
  salience: row.salience as ContinuityFact["salience"],
  ...(row.supersedes !== null ? { supersedes: row.supersedes } : {}),
  ...(row.expiresEpisode !== null ? { expiresEpisode: row.expiresEpisode } : {}),
});

/** Append-only: this class deliberately has no update or delete. */
export class PrismaContinuityRepository implements ContinuityRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async append(input: Parameters<ContinuityRepository["append"]>[0]): Promise<void> {
    const base = Date.now();
    try {
      // One statement, so a batch lands whole or not at all. Distinct createdAt keeps append order.
      await this.client.continuityFact.createMany({
        data: input.facts.map((fact, i) => ({
          workspaceId: input.workspaceId,
          seriesId: input.seriesId,
          factId: fact.id,
          episodeId: fact.episodeId,
          kind: fact.kind,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object ?? null,
          salience: fact.salience,
          supersedes: fact.supersedes ?? null,
          expiresEpisode: fact.expiresEpisode ?? null,
          createdAt: new Date(base + i),
        })),
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new Error("CONTINUITY_FACT_CONFLICT");
      throw error;
    }
  }

  public async listForSeries(input: Parameters<ContinuityRepository["listForSeries"]>[0]) {
    const rows = await this.client.continuityFact.findMany({
      where: { workspaceId: input.workspaceId, seriesId: input.seriesId },
      orderBy: [{ createdAt: "asc" }, { factId: "asc" }],
    });
    return rows.map(continuityFactFromRow);
  }
}
