import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentScript } from "@money-maker/core/content/editorial";
import { STORY_FIXTURES, fixtureIdea } from "@money-maker/core/story/fixtures";
import type { McpDependencies } from "../server.js";
import { createContentScriptTool } from "./content-scripts.js";
import { createEpisodePlanTool } from "./episode-plan.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const scripts: ContentScript[] = [];
const deps = (role: "owner" | "reviewer" = "owner"): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "W" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    addMembership: async () => undefined,
  },
  contentRepository: {
    findContentItemForWorkspace: async () => ({ id: "item-1", nicheId: "n", offerId: null }),
  } as unknown as NonNullable<McpDependencies["contentRepository"]>,
  offerRepository: {} as NonNullable<McpDependencies["offerRepository"]>,
  researchRepository: {} as NonNullable<McpDependencies["researchRepository"]>,
  editorialRepository: {
    nextScriptVersion: async () => 1,
    createScript: async (script: ContentScript) => {
      scripts.push(script);
      return script;
    },
  } as unknown as NonNullable<McpDependencies["editorialRepository"]>,
});

const planInput = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  episodeId: "ep-1",
  seriesId: "series-1",
  idea: fixtureIdea(),
  hook: "Why is the milk always at the back?",
  targetSec: 60,
  targetAudience: "general",
  contentIntent: "explainer",
  ...over,
});
const scriptInput = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  contentItemId: "item-1",
  body: "A short story about the back of the store. ".repeat(3),
  language: "en-US",
  claims: [],
  beats: [],
  ...over,
});

describe("create_episode_plan", () => {
  it("expands an idea into a lint-clean plan", async () => {
    const result = await createEpisodePlanTool(planInput(), actorId, deps());
    expect(result).toMatchObject({ ok: true, value: { violations: [] } });
    const plan = (result as unknown as { value: { episodePlan: { beats: unknown[] } } }).value
      .episodePlan;
    expect(plan.beats.length).toBeGreaterThan(5);
  });
  it("reports a hook that is too long without storing anything", async () => {
    const result = await createEpisodePlanTool(
      planInput({ hook: "one two three four five six seven eight nine ten" }),
      actorId,
      deps(),
    );
    expect(result).toMatchObject({ ok: true, value: { violations: ["hook_too_long"] } });
  });
  it.each([
    ["unknown field", planInput({ extra: 1 })],
    ["unknown template", planInput({ idea: { ...fixtureIdea(), template: "and_then" } })],
    ["empty cast", planInput({ idea: { ...fixtureIdea(), castIds: [] } })],
  ])("rejects %s", async (_n, input) => {
    expect(await createEpisodePlanTool(input, actorId, deps())).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
  it("denies a non-operator", async () => {
    expect(await createEpisodePlanTool(planInput(), actorId, deps("reviewer"))).toEqual({
      ok: false,
      error: "FORBIDDEN",
    });
  });
});

describe("create_content_script with episodePlan", () => {
  it("stores a clean plan on the script", async () => {
    scripts.length = 0;
    const result = await createContentScriptTool(
      scriptInput({ episodePlan: STORY_FIXTURES.explainer }),
      actorId,
      deps(),
    );
    expect(result.ok).toBe(true);
    expect(scripts[0]?.episodePlan?.id).toBe(STORY_FIXTURES.explainer.id);
  });
  it("rejects a plan with a lint violation", async () => {
    const bad = { ...STORY_FIXTURES.explainer, plants: [{ id: "p", beatId: "missing" }] };
    expect(
      await createContentScriptTool(scriptInput({ episodePlan: bad }), actorId, deps()),
    ).toEqual({ ok: false, error: "EPISODE_PLAN_REJECTED:plant_beat_unknown:p" });
  });
  it("rejects a malformed plan at the boundary", async () => {
    const malformed = { ...STORY_FIXTURES.explainer, surprise: true };
    expect(
      await createContentScriptTool(scriptInput({ episodePlan: malformed }), actorId, deps()),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
  it("still works without a plan", async () => {
    expect((await createContentScriptTool(scriptInput(), actorId, deps())).ok).toBe(true);
  });
});

describe("create_episode_plan novelty", () => {
  type Value = {
    episodePlan: { novelty?: { severity: string; code: string }[] };
    novelty: { severity: string; code: string }[];
  };
  const run = async (input: unknown) =>
    ((await createEpisodePlanTool(input, actorId, deps())) as unknown as { value: Value }).value;

  it("returns no signals and stores an empty list for a first episode", async () => {
    const value = await run(planInput());
    expect(value.novelty).toEqual([]);
    expect(value.episodePlan.novelty).toEqual([]);
  });
  it("warns, never blocks, when the series repeats itself, and stores the signals", async () => {
    const recent = [{ episodePlan: STORY_FIXTURES.explainer }];
    const value = await run(planInput({ recent }));
    expect(value.novelty.map((s) => s.code)).toEqual(
      expect.arrayContaining(["template_cooldown", "hook_form_cooldown", "place_cooldown"]),
    );
    expect(value.novelty.every((s) => s.severity === "LOG" || s.severity === "WARN")).toBe(true);
    expect(value.episodePlan.novelty).toEqual(value.novelty);
    // the signal-bearing plan is still accepted by create_content_script
    scripts.length = 0;
    const stored = await createContentScriptTool(
      scriptInput({ episodePlan: value.episodePlan }),
      actorId,
      deps(),
    );
    expect(stored.ok).toBe(true);
    expect(scripts[0]?.episodePlan?.novelty?.length).toBe(value.novelty.length);
  });
  it("uses the brand-time and sourced-fact inputs", async () => {
    const value = await run(planInput({ brandSec: 30, sourcedFactCount: 0 }));
    expect(value.novelty.map((s) => s.code)).toEqual(
      expect.arrayContaining(["brand_time_share", "empty_sourced_fact_slot"]),
    );
  });
  it("rejects more than 10 recent episodes and a BLOCK severity", async () => {
    const recent = Array.from({ length: 11 }, () => ({ episodePlan: STORY_FIXTURES.explainer }));
    expect(await createEpisodePlanTool(planInput({ recent }), actorId, deps())).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    const blocked = {
      ...STORY_FIXTURES.explainer,
      novelty: [{ code: "x", severity: "BLOCK", detail: "" }],
    };
    expect(
      await createContentScriptTool(scriptInput({ episodePlan: blocked }), actorId, deps()),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
