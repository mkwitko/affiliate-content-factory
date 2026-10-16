import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { PrismaContinuityRepository, continuityFactFromRow } from "./continuity-repository.js";
import type { DatabaseClient } from "./client.js";

const row = {
  factId: "k1",
  episodeId: "e1",
  kind: "possession",
  subject: "rafa",
  predicate: "has",
  object: null,
  salience: 3,
  supersedes: null,
  expiresEpisode: null,
};
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

describe("continuityFactFromRow", () => {
  it("omits null optionals", () => {
    expect(continuityFactFromRow(row)).toEqual({
      id: "k1",
      episodeId: "e1",
      kind: "possession",
      subject: "rafa",
      predicate: "has",
      salience: 3,
    });
  });
  it("keeps set optionals", () => {
    expect(
      continuityFactFromRow({ ...row, object: "key", supersedes: "k0", expiresEpisode: 4 }),
    ).toMatchObject({ object: "key", supersedes: "k0", expiresEpisode: 4 });
  });
});

describe("PrismaContinuityRepository", () => {
  it("scopes reads by workspace and series and appends with increasing createdAt", async () => {
    const calls: unknown[] = [];
    const client = {
      continuityFact: {
        createMany: async (args: unknown) => calls.push(args),
        findMany: async (args: unknown) => {
          calls.push(args);
          return [row];
        },
      },
    } as unknown as DatabaseClient;
    const repo = new PrismaContinuityRepository(client);
    await repo.append({
      workspaceId,
      seriesId: "s",
      facts: [
        { id: "a", episodeId: "e", kind: "event", subject: "x", predicate: "p", salience: 1 },
        { id: "b", episodeId: "e", kind: "event", subject: "x", predicate: "p", salience: 1 },
      ],
    });
    const data = (calls[0] as { data: { createdAt: Date; workspaceId: string }[] }).data;
    expect(data.every((d) => d.workspaceId === workspaceId)).toBe(true);
    expect(data[1]?.createdAt.getTime()).toBeGreaterThan(data[0]?.createdAt.getTime() ?? 0);
    expect(await repo.listForSeries({ workspaceId, seriesId: "s" })).toHaveLength(1);
    expect(calls[1]).toMatchObject({ where: { workspaceId, seriesId: "s" } });
  });
  it("maps a primary-key collision to a conflict", async () => {
    const client = {
      continuityFact: {
        createMany: async () => {
          throw Object.assign(new Error("dup"), { code: "P2002" });
        },
      },
    } as unknown as DatabaseClient;
    await expect(
      new PrismaContinuityRepository(client).append({ workspaceId, seriesId: "s", facts: [] }),
    ).rejects.toThrow("CONTINUITY_FACT_CONFLICT");
  });
});
