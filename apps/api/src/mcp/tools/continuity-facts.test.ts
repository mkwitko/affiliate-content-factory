import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContinuityRepository } from "@money-maker/core/story/continuity";
import { RECURRING_FACTS } from "@money-maker/core/story/fixtures";
import type { ContinuityFact } from "@money-maker/core/story/story";
import type { McpDependencies } from "../server.js";
import { listContinuityFactsTool, recordContinuityFactsTool } from "./continuity-facts.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspace = "890c73db-6c08-4143-8e68-1df6687a5504";

const fixture = (role: "owner" | "reviewer" = "owner") => {
  const store: { workspaceId: string; seriesId: string; fact: ContinuityFact }[] = [];
  const continuityRepository: ContinuityRepository = {
    append: async ({ workspaceId: w, seriesId, facts }) => {
      for (const fact of facts) store.push({ workspaceId: w, seriesId, fact });
    },
    listForSeries: async ({ workspaceId: w, seriesId }) =>
      store.filter((r) => r.workspaceId === w && r.seriesId === seriesId).map((r) => r.fact),
  };
  const deps: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "W" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
      findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
      addMembership: async () => undefined,
    },
    continuityRepository,
  };
  return { deps, store };
};
const record = (facts: readonly ContinuityFact[], seriesId = "shop") => ({
  workspaceId,
  seriesId,
  facts,
});

describe("continuity tools", () => {
  it("records three episodes of the recurring fixture and lists the active facts", async () => {
    const { deps } = fixture();
    for (const episode of RECURRING_FACTS)
      expect(await recordContinuityFactsTool(record(episode), actorId, deps)).toEqual({
        ok: true,
        value: { recorded: episode.length },
      });
    const listed = await listContinuityFactsTool(
      { workspaceId, seriesId: "shop", castIds: ["bia", "rafa", "carla"], currentEpisode: 3 },
      actorId,
      deps,
    );
    const ids = (listed as unknown as { value: { facts: { id: string }[] } }).value.facts.map(
      (f) => f.id,
    );
    expect(ids).not.toContain("k1");
    expect(ids).not.toContain("k5");
    expect(ids).toContain("k6");
  });
  it("rejects a contradiction and stores nothing", async () => {
    const { deps, store } = fixture();
    await recordContinuityFactsTool(record(RECURRING_FACTS[0] ?? []), actorId, deps);
    const before = store.length;
    const result = await recordContinuityFactsTool(
      record([
        {
          id: "x",
          episodeId: "e",
          kind: "possession",
          subject: "carla",
          predicate: "has",
          object: "key",
          salience: 3,
        },
      ]),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "CONTINUITY_REJECTED:possession_conflict:key" });
    expect(store).toHaveLength(before);
  });
  it("keeps series and workspaces apart", async () => {
    const { deps } = fixture();
    await recordContinuityFactsTool(record(RECURRING_FACTS[0] ?? [], "shop"), actorId, deps);
    const otherSeries = await listContinuityFactsTool(
      { workspaceId, seriesId: "other", castIds: ["rafa"] },
      actorId,
      deps,
    );
    expect(otherSeries).toEqual({ ok: true, value: { facts: [] } });
    expect(
      await deps.continuityRepository?.listForSeries({
        workspaceId: parseWorkspaceId(otherWorkspace),
        seriesId: "shop",
      }),
    ).toEqual([]);
  });
  it.each([
    ["extra field", { ...record(RECURRING_FACTS[0] ?? []), extra: 1 }],
    ["empty facts", record([])],
    [
      "bad salience",
      record([
        { id: "x", episodeId: "e", kind: "event", subject: "s", predicate: "p", salience: 4 as 1 },
      ]),
    ],
    [
      "bad kind",
      record([
        {
          id: "x",
          episodeId: "e",
          kind: "rumour" as "event",
          subject: "s",
          predicate: "p",
          salience: 1,
        },
      ]),
    ],
  ])("rejects %s", async (_n, input) => {
    expect(await recordContinuityFactsTool(input, actorId, fixture().deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
  it("lets a reviewer read but not write", async () => {
    const { deps } = fixture("reviewer");
    expect(
      await recordContinuityFactsTool(record(RECURRING_FACTS[0] ?? []), actorId, deps),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(
      await listContinuityFactsTool(
        { workspaceId, seriesId: "shop", castIds: ["bia"] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: true, value: { facts: [] } });
  });
  it("reports a duplicate fact id raised by the repository as a rejection", async () => {
    const { deps } = fixture();
    const racing: McpDependencies = {
      ...deps,
      continuityRepository: {
        listForSeries: async () => [],
        append: async () => {
          throw new Error("CONTINUITY_FACT_CONFLICT");
        },
      },
    };
    expect(
      await recordContinuityFactsTool(record(RECURRING_FACTS[0] ?? []), actorId, racing),
    ).toEqual({
      ok: false,
      error: "CONTINUITY_REJECTED:duplicate_fact",
    });
  });
});
