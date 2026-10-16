import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { EpisodeIdea } from "@money-maker/core/youtube/episode-idea";
import { PrismaEpisodeIdeaRepository, episodeIdeaFromRow } from "./episode-idea-repository.js";
import type { DatabaseClient } from "./client.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const score = { dimensions: {}, total: 90, rationale: "r", confidence: "low", evidence: [] };
const row = {
  id: "i1",
  workspaceId,
  nicheId: "n1",
  workingTitle: "Milk",
  status: "idea",
  score,
  packaging: null,
  packagingChecks: null,
  selectedVariantId: null,
  hookContract: null,
  decisionNote: null,
  contentItemId: null,
  createdAt: new Date(0),
  updatedAt: new Date(1),
};

describe("episodeIdeaFromRow", () => {
  it("omits null optionals", () => {
    expect(episodeIdeaFromRow(row)).toEqual({
      id: "i1",
      workspaceId,
      nicheId: "n1",
      workingTitle: "Milk",
      status: "idea",
      score,
      createdAt: new Date(0),
      updatedAt: new Date(1),
    });
  });
  it("keeps set optionals", () => {
    expect(
      episodeIdeaFromRow({
        ...row,
        selectedVariantId: "A",
        decisionNote: "ok",
        contentItemId: "c",
      }),
    ).toMatchObject({ selectedVariantId: "A", decisionNote: "ok", contentItemId: "c" });
  });
});

describe("PrismaEpisodeIdeaRepository", () => {
  it("scopes every query by workspace", async () => {
    const calls: unknown[] = [];
    const client = {
      episodeIdea: {
        createMany: async (a: unknown) => calls.push(a),
        findFirst: async (a: unknown) => {
          calls.push(a);
          return null;
        },
        findMany: async (a: unknown) => {
          calls.push(a);
          return [row];
        },
        updateMany: async (a: unknown) => {
          calls.push(a);
          return { count: 0 };
        },
      },
    } as unknown as DatabaseClient;
    const repo = new PrismaEpisodeIdeaRepository(client);
    const idea = episodeIdeaFromRow(row) as EpisodeIdea;
    await repo.createMany([idea]);
    expect(await repo.findForWorkspace({ workspaceId, ideaId: "i1" })).toBeNull();
    expect(
      await repo.listForNiche({ workspaceId, nicheId: "n1", status: "approved" }),
    ).toHaveLength(1);
    expect(await repo.save(idea)).toBe(false);
    expect((calls[0] as { data: { workspaceId: string }[] }).data[0]?.workspaceId).toBe(
      workspaceId,
    );
    expect(calls[1]).toMatchObject({ where: { id: "i1", workspaceId } });
    expect(calls[2]).toMatchObject({ where: { workspaceId, nicheId: "n1", status: "approved" } });
    expect(calls[3]).toMatchObject({ where: { id: "i1", workspaceId } });
  });
});
