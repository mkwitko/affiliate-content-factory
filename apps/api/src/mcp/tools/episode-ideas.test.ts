import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { EpisodeIdea } from "@money-maker/core/youtube/episode-idea";
import type { EpisodeIdeaRepository } from "@money-maker/core/youtube/episode-idea-repository";
import type { McpDependencies } from "../server.js";
import {
  createEpisodeIdeasTool,
  decideEpisodeIdeaTool,
  listEpisodeIdeasTool,
  recordEpisodePackagingTool,
} from "./episode-ideas.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspace = "890c73db-6c08-4143-8e68-1df6687a5504";

const packagingNiche = (over: Partial<Niche> = {}): Niche => ({
  id: "n1",
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
    packaging: {
      titlePatterns: [
        { id: "CC1", label: "WHY_BEHAVIOR" },
        { id: "CC5", label: "PRICE" },
      ],
      hookPatterns: [{ id: "HK1", label: "RESTATE" }],
    },
  },
  ...over,
});

const fixture = (role: "owner" | "reviewer" = "owner", niche: Niche | null = packagingNiche()) => {
  const store = new Map<string, EpisodeIdea>();
  const episodeIdeaRepository: EpisodeIdeaRepository = {
    createMany: async (ideas) => {
      for (const idea of ideas) store.set(idea.id, idea);
    },
    findForWorkspace: async ({ workspaceId: w, ideaId }) => {
      const idea = store.get(ideaId);
      return idea && idea.workspaceId === w ? idea : null;
    },
    listForNiche: async ({ workspaceId: w, nicheId, status }) =>
      [...store.values()].filter(
        (i) => i.workspaceId === w && i.nicheId === nicheId && (!status || i.status === status),
      ),
    save: async (idea) => {
      if (!store.has(idea.id)) return false;
      store.set(idea.id, idea);
      return true;
    },
  };
  const deps: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "W" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
      findMembership: async ({ workspaceId: w }) =>
        w === workspaceId ? { workspaceId, userId: actorId, role, status: "active" } : null,
      addMembership: async () => undefined,
    },
    nicheRepository: {
      create: async (n) => n,
      updateState: async () => null,
      findForWorkspace: async ({ workspaceId: w, nicheId }) =>
        niche && w === niche.workspaceId && nicheId === niche.id ? niche : null,
    } as NonNullable<McpDependencies["nicheRepository"]>,
    episodeIdeaRepository,
  };
  return { deps, store };
};

const dimensions = {
  browse: 12,
  title: 8,
  thumbnail: 8,
  hook: 8,
  story: 12,
  evergreen: 8,
  audienceEvidence: 6,
  libraryAdjacency: 3,
  monetization: 3,
  feasibility: 4,
  originality: 4,
};
const idea = (workingTitle: string, over: Record<string, number> = {}) => ({
  workingTitle,
  score: {
    dimensions: { ...dimensions, ...over },
    rationale: "r",
    confidence: "medium",
    evidence: [{ statement: "s", evidenceType: "OUR_HYPOTHESIS" }],
  },
});
const variant = (id: string, title: string, overlayText?: string) => ({
  id,
  title,
  titlePattern: "CC1",
  thumbnail: {
    angle: "a",
    focalSubject: "milk",
    composition: "c",
    background: "b",
    contrastStrategy: "s",
    titleThumbnailSplit: "t",
    hypothesis: "h",
    ...(overlayText ? { overlayText } : {}),
  },
  hookPattern: "HK1",
  openingHook: "o",
  audiencePromise: "p",
  hypothesis: "h",
});
const contract = {
  packagingPromise: "p",
  firstVisual: "v",
  proofOrTensionBySecond: 8,
  firstOpenLoop: "l",
  firstOpenLoopBySecond: 10,
  firstPartialPayoffBySecond: 25,
  prohibitedIntroElements: [],
};
const ids = (r: unknown) =>
  (r as { value: { ideas: { id: string }[] } }).value.ideas.map((i) => i.id);
const created = async (deps: McpDependencies) => {
  const r = await createEpisodeIdeasTool(
    { workspaceId, nicheId: "n1", ideas: [idea("Milk")] },
    actorId,
    deps,
  );
  return ids(r)[0] as string;
};
const packaged = async (deps: McpDependencies) => {
  const ideaId = await created(deps);
  const r = await recordEpisodePackagingTool(
    {
      workspaceId,
      ideaId,
      variants: [
        variant("A", "Why Supermarkets Put Milk in the Back", "THE LONG WALK"),
        variant("B", "Why Milk Sits at the Back", "milk back"),
      ],
    },
    actorId,
    deps,
  );
  return { ideaId, r };
};

describe("episode idea tools", () => {
  it("creates ideas with a computed total and lists them best first", async () => {
    const { deps } = fixture();
    const r = await createEpisodeIdeasTool(
      { workspaceId, nicheId: "n1", ideas: [idea("Low", { browse: 1 }), idea("High")] },
      actorId,
      deps,
    );
    expect(
      (r as unknown as { value: { ideas: { total: number }[] } }).value.ideas.map((i) => i.total),
    ).toEqual([65, 76]);
    const listed = await listEpisodeIdeasTool({ workspaceId, nicheId: "n1" }, actorId, deps);
    expect(
      (listed as unknown as { value: { ideas: { workingTitle: string }[] } }).value.ideas.map(
        (i) => i.workingTitle,
      ),
    ).toEqual(["High", "Low"]);
  });
  it("returns the existing idea when a normalized title is created again", async () => {
    const { deps, store } = fixture();
    const first = await created(deps);
    const again = await createEpisodeIdeasTool(
      { workspaceId, nicheId: "n1", ideas: [idea("  MILK! "), idea("Eggs"), idea("eggs")] },
      actorId,
      deps,
    );
    const out = (again as unknown as { value: { ideas: { id: string; existing: boolean }[] } })
      .value.ideas;
    expect(out[0]).toMatchObject({ id: first, existing: true });
    expect(out.map((i) => i.existing)).toEqual([true, false, true]);
    expect(out[2]?.id).toBe(out[1]?.id);
    expect(store.size).toBe(2);
    // An archived idea does not block a fresh one with the same title.
    const archived = store.get(first) as EpisodeIdea;
    store.set(first, { ...archived, status: "archived" });
    const fresh = await createEpisodeIdeasTool(
      { workspaceId, nicheId: "n1", ideas: [idea("Milk")] },
      actorId,
      deps,
    );
    expect(ids(fresh)[0]).not.toBe(first);
    expect(store.size).toBe(3);
  });
  it("lets a rejected title be proposed again, and never matches an empty normalized title", async () => {
    const { deps, store } = fixture();
    const first = await created(deps);
    const rejectedIdea = store.get(first) as EpisodeIdea;
    store.set(first, { ...rejectedIdea, status: "rejected" });
    const again = await createEpisodeIdeasTool(
      { workspaceId, nicheId: "n1", ideas: [idea("Milk")] },
      actorId,
      deps,
    );
    expect(ids(again)[0]).not.toBe(first);
    const blank = await createEpisodeIdeasTool(
      { workspaceId, nicheId: "n1", ideas: [idea("???"), idea("!!!")] },
      actorId,
      deps,
    );
    const out = (blank as unknown as { value: { ideas: { existing: boolean }[] } }).value.ideas;
    expect(out.map((i) => i.existing)).toEqual([false, false]);
  });
  it("rejects a score total, an out-of-range dimension and a niche without a profile", async () => {
    const { deps } = fixture();
    const withTotal = idea("x");
    (withTotal.score as Record<string, unknown>).total = 100;
    expect(
      await createEpisodeIdeasTool(
        { workspaceId, nicheId: "n1", ideas: [withTotal] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    expect(
      await createEpisodeIdeasTool(
        { workspaceId, nicheId: "n1", ideas: [idea("x", { title: 11 })] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "EPISODE_IDEA_REJECTED:score_out_of_range" });
    const bare = fixture("owner", packagingNiche({ context: {} }));
    expect(
      await createEpisodeIdeasTool(
        { workspaceId, nicheId: "n1", ideas: [idea("x")] },
        actorId,
        bare.deps,
      ),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:packaging_profile_missing",
    });
    const affiliate = fixture("owner", packagingNiche({ kind: "affiliate" }));
    expect(
      await createEpisodeIdeasTool(
        { workspaceId, nicheId: "n1", ideas: [idea("x")] },
        actorId,
        affiliate.deps,
      ),
    ).toEqual({
      ok: false,
      error: "NICHE_KIND_MISMATCH",
    });
  });
  it("denies a reviewer writes, allows reads, and hides ideas of another workspace", async () => {
    const { deps } = fixture("reviewer");
    expect(
      await createEpisodeIdeasTool(
        { workspaceId, nicheId: "n1", ideas: [idea("x")] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
    expect((await listEpisodeIdeasTool({ workspaceId, nicheId: "n1" }, actorId, deps)).ok).toBe(
      true,
    );
    expect(
      await listEpisodeIdeasTool({ workspaceId: otherWorkspace, nicheId: "n1" }, actorId, deps),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });
  it("records packaging and returns the checks", async () => {
    const { deps, store } = fixture();
    const { ideaId, r } = await packaged(deps);
    const checks = (
      r as unknown as { value: { checks: { variantId: string; duplicateMessage: boolean }[] } }
    ).value.checks;
    expect(checks.map((c) => [c.variantId, c.duplicateMessage])).toEqual([
      ["A", false],
      ["B", true],
    ]);
    expect(store.get(ideaId)?.status).toBe("packaging");
  });
  it("rejects packaging with a pattern outside the profile", async () => {
    const { deps } = fixture();
    const ideaId = await created(deps);
    const bad = { ...variant("A", "Why X"), titlePattern: "CC9" };
    expect(
      await recordEpisodePackagingTool(
        { workspaceId, ideaId, variants: [bad, variant("B", "Why Y")] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "EPISODE_IDEA_REJECTED:unknown_title_pattern" });
  });
  it("approves a clean variant with a hook contract, and refuses a repeated-title one", async () => {
    const { deps, store } = fixture();
    const { ideaId } = await packaged(deps);
    expect(
      await decideEpisodeIdeaTool(
        { workspaceId, ideaId, decision: "approve", variantId: "B", hookContract: contract },
        actorId,
        deps,
      ),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:duplicate_message",
    });
    expect(
      await decideEpisodeIdeaTool(
        { workspaceId, ideaId, decision: "approve", variantId: "A" },
        actorId,
        deps,
      ),
    ).toEqual({
      ok: false,
      error: "EPISODE_IDEA_REJECTED:hook_contract_missing",
    });
    expect(
      await decideEpisodeIdeaTool(
        { workspaceId, ideaId, decision: "approve", variantId: "A", hookContract: contract },
        actorId,
        deps,
      ),
    ).toEqual({
      ok: true,
      value: { ideaId, status: "approved" },
    });
    expect(store.get(ideaId)?.selectedVariantId).toBe("A");
  });
  it("revises and rejects, and cannot decide an idea of another workspace", async () => {
    const { deps } = fixture();
    const { ideaId } = await packaged(deps);
    expect(
      await decideEpisodeIdeaTool(
        { workspaceId, ideaId, decision: "revise", note: "shorter" },
        actorId,
        deps,
      ),
    ).toMatchObject({ ok: true, value: { status: "packaging" } });
    expect(
      await decideEpisodeIdeaTool({ workspaceId, ideaId, decision: "reject" }, actorId, deps),
    ).toMatchObject({ ok: true, value: { status: "rejected" } });
    expect(
      await decideEpisodeIdeaTool({ workspaceId, ideaId, decision: "reject" }, actorId, deps),
    ).toEqual({ ok: false, error: "EPISODE_IDEA_REJECTED:invalid_transition" });
    expect(
      await decideEpisodeIdeaTool(
        { workspaceId: otherWorkspace, ideaId, decision: "reject" },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
