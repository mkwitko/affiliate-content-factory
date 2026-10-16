import type { UserId, WorkspaceId } from "@money-maker/contracts";
import {
  EPISODE_IDEA_STATUSES,
  EpisodeIdeaError,
  createEpisodeIdea,
  decideIdea,
  normalizeWorkingTitle,
  recordPackaging,
  scoreIdea,
  type EpisodeIdea,
  type HookContract,
  type IdeaEvidence,
  type PackagingVariant,
} from "@money-maker/core/youtube/episode-idea";
import { readPackagingProfile } from "@money-maker/core/youtube/channel-profile";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const points = z.number().min(0).max(15);
const evidenceSchema = z
  .object({
    statement: text(300),
    evidenceType: z.enum([
      "OFFICIAL_PLATFORM_FACT",
      "CHANNEL_OBSERVATION",
      "EXTERNAL_HEURISTIC",
      "OUR_HYPOTHESIS",
    ]),
    source: text(300).optional(),
    observationId: z.uuid().optional(),
  })
  .strict();
// Per-dimension maxima are enforced by scoreIdea; `total` is deliberately not accepted.
const scoreSchema = z
  .object({
    dimensions: z
      .object({
        browse: points,
        title: points,
        thumbnail: points,
        hook: points,
        story: points,
        evergreen: points,
        audienceEvidence: points,
        libraryAdjacency: points,
        monetization: points,
        feasibility: points,
        originality: points,
      })
      .strict(),
    rationale: text(1000),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.array(evidenceSchema).max(10),
  })
  .strict();
const thumbnailSchema = z
  .object({
    angle: text(200),
    focalSubject: text(200),
    secondaryObject: text(200).optional(),
    overlayText: text(80).optional(),
    composition: text(300),
    background: text(300),
    contrastStrategy: text(300),
    emotion: text(100).optional(),
    titleThumbnailSplit: text(300),
    hypothesis: text(300),
  })
  .strict();
const variantSchema = z
  .object({
    id: z.enum(["A", "B", "C"]),
    title: text(100),
    titlePattern: text(10),
    thumbnail: thumbnailSchema,
    hookPattern: text(10),
    openingHook: text(500),
    audiencePromise: text(300),
    hypothesis: text(300),
    expectedStrengths: z.array(text(200)).max(5).optional(),
    risks: z.array(text(200)).max(5).optional(),
  })
  .strict();
const second = z.number().int().min(1).max(60);
const hookContractSchema = z
  .object({
    packagingPromise: text(300),
    firstVisual: text(300),
    proofOrTensionBySecond: second,
    firstOpenLoop: text(300),
    firstOpenLoopBySecond: second,
    firstPartialPayoffBySecond: second,
    deeperQuestion: text(300).optional(),
    prohibitedIntroElements: z.array(text(120)).max(10),
  })
  .strict();

export const createEpisodeIdeasInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: text(200),
    ideas: z
      .array(z.object({ workingTitle: text(200), score: scoreSchema }).strict())
      .min(1)
      .max(12),
  })
  .strict();
export const listEpisodeIdeasInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: text(200),
    status: z.enum(EPISODE_IDEA_STATUSES as readonly [string, ...string[]]).optional(),
  })
  .strict();
export const recordEpisodePackagingInputSchema = z
  .object({
    workspaceId: z.uuid(),
    ideaId: text(200),
    variants: z.array(variantSchema).min(2).max(3),
  })
  .strict();
export const decideEpisodeIdeaInputSchema = z
  .object({
    workspaceId: z.uuid(),
    ideaId: text(200),
    decision: z.enum(["approve", "revise", "reject"]),
    variantId: z.enum(["A", "B", "C"]).optional(),
    hookContract: hookContractSchema.optional(),
    note: text(500).optional(),
  })
  .strict();

const rejected = (error: unknown): ToolResult | null =>
  error instanceof EpisodeIdeaError
    ? { ok: false, error: `EPISODE_IDEA_REJECTED:${error.code}` }
    : null;

/** Repository, workspace id and role check shared by the four tools. */
const open = async (
  parsed: { workspaceId: string },
  actorId: UserId,
  deps: McpDependencies,
  roles: Parameters<typeof authorizeWorkspaceTool>[3],
): Promise<{ workspaceId: WorkspaceId } | ToolResult> => {
  if (!deps.episodeIdeaRepository || !deps.nicheRepository)
    throw new Error("Episode idea dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  return (await authorizeWorkspaceTool(deps, actorId, workspaceId, roles)) ?? { workspaceId };
};
const isResult = (value: { workspaceId: WorkspaceId } | ToolResult): value is ToolResult =>
  "ok" in value;

/** The media niche's packaging profile, or the error to return. */
const nicheProfile = async (deps: McpDependencies, workspaceId: WorkspaceId, nicheId: string) => {
  const niche = await deps.nicheRepository?.findForWorkspace({ workspaceId, nicheId });
  if (!niche) return { error: { ok: false, error: "NOT_FOUND" } as const };
  if (niche.kind !== "media")
    return { error: { ok: false, error: "NICHE_KIND_MISMATCH" } as const };
  const profile = readPackagingProfile(niche);
  if (!profile)
    return {
      error: { ok: false, error: "EPISODE_IDEA_REJECTED:packaging_profile_missing" } as const,
    };
  return { profile };
};

export const createEpisodeIdeasTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createEpisodeIdeasInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const access = await open(parsed.data, actorId, deps, ["owner", "operator"]);
  if (isResult(access)) return access;
  const { workspaceId } = access;
  const checked = await nicheProfile(deps, workspaceId, parsed.data.nicheId);
  if (checked.error) return checked.error;
  const now = new Date();
  // Idempotent: a title already live (not archived or rejected) in this niche, or repeated in this call,
  // returns the existing idea instead of a duplicate.
  const known = new Map<string, EpisodeIdea>();
  // A title that normalizes to "" carries no identity, so it never matches anything.
  const remember = (idea: EpisodeIdea) => {
    const key = normalizeWorkingTitle(idea.workingTitle);
    if (key) known.set(key, idea);
  };
  for (const idea of (await deps.episodeIdeaRepository?.listForNiche({
    workspaceId,
    nicheId: parsed.data.nicheId,
  })) ?? [])
    if (idea.status !== "archived" && idea.status !== "rejected") remember(idea);
  const created: EpisodeIdea[] = [];
  const results: { idea: EpisodeIdea; existing: boolean }[] = [];
  try {
    for (const entry of parsed.data.ideas) {
      const key = normalizeWorkingTitle(entry.workingTitle);
      const match = known.get(key);
      if (match) {
        results.push({ idea: match, existing: true });
        continue;
      }
      const idea = createEpisodeIdea({
        workspaceId,
        nicheId: parsed.data.nicheId,
        workingTitle: entry.workingTitle,
        score: scoreIdea({ ...entry.score, evidence: entry.score.evidence as IdeaEvidence[] }),
        now,
      });
      remember(idea);
      created.push(idea);
      results.push({ idea, existing: false });
    }
  } catch (error) {
    const result = rejected(error);
    if (result) return result;
    throw error;
  }
  if (created.length > 0) {
    await deps.episodeIdeaRepository?.createMany(created);
    await deps.audit?.record({
      action: "episode.idea.created",
      workspaceId,
      actorUserId: actorId,
      targetType: "Niche",
      targetId: parsed.data.nicheId,
      metadata: { count: created.length },
    });
  }
  return {
    ok: true,
    value: {
      ideas: results.map(({ idea, existing }) => ({
        id: idea.id,
        workingTitle: idea.workingTitle,
        total: idea.score.total,
        existing,
      })),
    },
  };
};

export const listEpisodeIdeasTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listEpisodeIdeasInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const access = await open(parsed.data, actorId, deps, ["owner", "operator", "reviewer"]);
  if (isResult(access)) return access;
  const ideas = await deps.episodeIdeaRepository?.listForNiche({
    workspaceId: access.workspaceId,
    nicheId: parsed.data.nicheId,
    ...(parsed.data.status ? { status: parsed.data.status as EpisodeIdea["status"] } : {}),
  });
  return {
    ok: true,
    value: {
      ideas: [...(ideas ?? [])].sort(
        (a, b) => b.score.total - a.score.total || a.createdAt.getTime() - b.createdAt.getTime(),
      ),
    },
  };
};

export const recordEpisodePackagingTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordEpisodePackagingInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const access = await open(parsed.data, actorId, deps, ["owner", "operator"]);
  if (isResult(access)) return access;
  const { workspaceId } = access;
  const idea = await deps.episodeIdeaRepository?.findForWorkspace({
    workspaceId,
    ideaId: parsed.data.ideaId,
  });
  if (!idea) return { ok: false, error: "NOT_FOUND" };
  const checked = await nicheProfile(deps, workspaceId, idea.nicheId);
  if (checked.error) return checked.error;
  try {
    const variants = parsed.data.variants as readonly PackagingVariant[];
    const next = recordPackaging(idea, variants, checked.profile, new Date());
    await deps.episodeIdeaRepository?.save(next);
    await deps.audit?.record({
      action: "episode.idea.packaged",
      workspaceId,
      actorUserId: actorId,
      targetType: "EpisodeIdea",
      targetId: idea.id,
      metadata: { variants: variants.length },
    });
    return {
      ok: true,
      value: { ideaId: idea.id, status: next.status, checks: next.packagingChecks ?? [] },
    };
  } catch (error) {
    const result = rejected(error);
    if (result) return result;
    throw error;
  }
};

export const decideEpisodeIdeaTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = decideEpisodeIdeaInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const access = await open(parsed.data, actorId, deps, ["owner", "operator"]);
  if (isResult(access)) return access;
  const { workspaceId } = access;
  const idea = await deps.episodeIdeaRepository?.findForWorkspace({
    workspaceId,
    ideaId: parsed.data.ideaId,
  });
  if (!idea) return { ok: false, error: "NOT_FOUND" };
  try {
    const next = decideIdea(
      idea,
      {
        decision: parsed.data.decision,
        variantId: parsed.data.variantId,
        hookContract: parsed.data.hookContract as HookContract | undefined,
        note: parsed.data.note,
      },
      new Date(),
    );
    await deps.episodeIdeaRepository?.save(next);
    await deps.audit?.record({
      action: "episode.idea.decided",
      workspaceId,
      actorUserId: actorId,
      targetType: "EpisodeIdea",
      targetId: idea.id,
      metadata: { decision: parsed.data.decision, status: next.status },
    });
    return { ok: true, value: { ideaId: idea.id, status: next.status } };
  } catch (error) {
    const result = rejected(error);
    if (result) return result;
    throw error;
  }
};
