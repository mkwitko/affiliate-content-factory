import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentItem } from "@money-maker/core/content/content";
import type { ContentScript } from "@money-maker/core/content/editorial";
import type { Niche } from "@money-maker/core/niches/niche";
import type { EpisodeIdea } from "@money-maker/core/youtube/episode-idea";
import type { McpDependencies } from "../server.js";
import { createContentScriptTool } from "./content-scripts.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspace = parseWorkspaceId("890c73db-6c08-4143-8e68-1df6687a5504");

const niche: Niche = {
  id: "media",
  workspaceId,
  name: "Cost Curious",
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["en"],
  monetizationHypothesis: "m",
  state: "active",
  kind: "media",
  context: {
    forbiddenPhrases: ["game changer"],
    packaging: {
      titlePatterns: [{ id: "CC1", label: "WHY" }],
      hookPatterns: [{ id: "HK1", label: "R" }],
    },
  },
};
const item = (id: string, nicheId = "media"): ContentItem => ({
  id,
  workspaceId,
  nicheId,
  offerId: null,
  offerSnapshotId: null,
  title: "Why milk is at the back",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
});
const approvedIdea = (over: Partial<EpisodeIdea> = {}): EpisodeIdea => ({
  id: "idea-1",
  workspaceId,
  nicheId: "media",
  workingTitle: "Milk",
  status: "approved",
  score: {
    dimensions: {} as EpisodeIdea["score"]["dimensions"],
    total: 80,
    rationale: "r",
    confidence: "low",
    evidence: [],
  },
  packaging: [
    {
      id: "A",
      title: "Why Supermarkets Put Milk in the Back",
      titlePattern: "CC1",
      thumbnail: {
        angle: "a",
        focalSubject: "f",
        composition: "c",
        background: "b",
        contrastStrategy: "s",
        titleThumbnailSplit: "t",
        hypothesis: "h",
      },
      hookPattern: "HK1",
      openingHook: "o",
      audiencePromise: "p",
      hypothesis: "h",
    },
  ],
  selectedVariantId: "A",
  hookContract: {
    packagingPromise: "p",
    firstVisual: "v",
    proofOrTensionBySecond: 8,
    firstOpenLoop: "l",
    firstOpenLoopBySecond: 10,
    firstPartialPayoffBySecond: 25,
    prohibitedIntroElements: [],
  },
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const fixture = (idea: EpisodeIdea | null = approvedIdea()) => {
  const saved: EpisodeIdea[] = [];
  const scripts: ContentScript[] = [];
  const deps: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "W" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
      addMembership: async () => undefined,
    },
    nicheRepository: {
      create: async (n) => n,
      updateState: async () => null,
      findForWorkspace: async () => niche,
    },
    contentRepository: {
      findContentItemForWorkspace: async ({ contentItemId }: { contentItemId: string }) =>
        item(contentItemId, contentItemId === "item-affiliate" ? "casa" : "media"),
    } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    offerRepository: { findForWorkspace: async () => null } as unknown as NonNullable<
      McpDependencies["offerRepository"]
    >,
    researchRepository: {
      findObservationForWorkspace: async () => ({ expiresAt: new Date(Date.now() + 86_400_000) }),
    } as unknown as NonNullable<McpDependencies["researchRepository"]>,
    editorialRepository: {
      nextScriptVersion: async () => 1,
      createScript: async (script: ContentScript) => {
        scripts.push(script);
        return script;
      },
    } as unknown as NonNullable<McpDependencies["editorialRepository"]>,
    episodeIdeaRepository: {
      createMany: async () => undefined,
      findForWorkspace: async ({ workspaceId: w, ideaId }) =>
        idea && w === idea.workspaceId && ideaId === idea.id ? idea : null,
      listForNiche: async () => [],
      save: async (next) => {
        saved.push(next);
        return true;
      },
    },
  };
  return { deps, saved, scripts };
};
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const input = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  contentItemId: "item-1",
  body: `Supermarkets put milk in the back. ${words(90)}`,
  language: "en",
  claims: [
    {
      text: "Dairy needs refrigeration at the back wall",
      kind: "verified_fact",
      evidence: [
        { kind: "research_observation", observationId: "33333333-3333-4333-8333-333333333333" },
      ],
    },
  ],
  beats: [
    { kind: "hook", atChar: 0, label: "hidden_reason" },
    { kind: "open_loop", atChar: 10 },
    { kind: "number_reveal", atChar: 20 },
    { kind: "payoff", atChar: 200 },
  ],
  ...over,
});

describe("create_content_script with episodeIdeaId", () => {
  it("accepts the new beat kinds and works unchanged without an idea", async () => {
    const { deps, saved } = fixture();
    const result = await createContentScriptTool(input(), actorId, deps);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && "hookReview" in result.value).toBe(false);
    expect(saved).toEqual([]);
  });
  it("moves an approved idea to in_production and returns the hook review", async () => {
    const { deps, saved } = fixture();
    const result = await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, deps);
    expect(result).toMatchObject({
      ok: true,
      value: { forbiddenPhrases: ["game changer"], hookReview: { checks: expect.any(Array) } },
    });
    expect(saved[0]).toMatchObject({ status: "in_production", contentItemId: "item-1" });
  });
  it("accepts a further script for the content item already in production", async () => {
    const { deps, saved } = fixture(
      approvedIdea({ status: "in_production", contentItemId: "item-1" }),
    );
    expect(
      (await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, deps)).ok,
    ).toBe(true);
    expect(saved).toEqual([]);
  });
  it("refuses an idea that is not approved, belongs to another item, or another niche", async () => {
    const notApproved = fixture(approvedIdea({ status: "packaging" }));
    expect(
      await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, notApproved.deps),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:idea_not_approved",
    });
    const elsewhere = fixture(approvedIdea({ status: "in_production", contentItemId: "item-9" }));
    expect(
      await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, elsewhere.deps),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:idea_in_production_elsewhere",
    });
    const otherNiche = fixture(approvedIdea({ nicheId: "casa" }));
    expect(
      await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, otherNiche.deps),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:niche_mismatch",
    });
    expect(notApproved.scripts).toEqual([]);
  });
  it("does not find an idea of another workspace or an unknown idea", async () => {
    const foreign = fixture(approvedIdea({ workspaceId: otherWorkspace }));
    expect(
      await createContentScriptTool(input({ episodeIdeaId: "idea-1" }), actorId, foreign.deps),
    ).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    const { deps } = fixture();
    expect(
      await createContentScriptTool(input({ episodeIdeaId: "missing" }), actorId, deps),
    ).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });
});
