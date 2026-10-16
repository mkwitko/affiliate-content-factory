import {
  createContentScript,
  type ClaimInput,
  withClaimKindDefault,
  type EvidenceRef,
} from "@money-maker/core/content/editorial";
import { numbersWithoutEvidence } from "@money-maker/core/content/preview-content";
import { readExplainerContext } from "@money-maker/core/explainer/explainer-context";
import { validateExplainerScript } from "@money-maker/core/explainer/script-guards";
import { readPackagingProfile } from "@money-maker/core/youtube/channel-profile";
import { startProduction } from "@money-maker/core/youtube/episode-idea";
import { reviewHook } from "@money-maker/core/youtube/hook-review";
import type { UserId } from "@money-maker/contracts";
import { lintEpisode, type EpisodeSpec } from "@money-maker/core/story/story";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { episodeSpecSchema } from "./episode-plan.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const evidenceRef = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("commercial_fact"),
      snapshotId: z.string().min(1),
      key: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("research_observation"), observationId: z.uuid() }).strict(),
]);
const claimSchema = z
  .object({
    text: z.string().trim().min(1).max(300),
    // verified_fact (default) needs evidence; reasonable_simplification needs a note.
    kind: z
      .enum([
        "verified_fact",
        "reasonable_simplification",
        "analogy",
        "hypothesis",
        "fictional_example",
      ])
      .optional(),
    note: z.string().trim().min(1).max(300).optional(),
    evidence: z.array(evidenceRef).max(10),
  })
  .strict();
const beatSchema = z
  .object({
    kind: z.enum([
      "hook",
      "promise",
      "open_loop",
      "payoff",
      "pattern_interrupt",
      "chapter",
      "cta",
      "number_reveal",
      "twist",
      "rehook",
      "next_video_bridge",
    ]),
    atChar: z.number().int().min(0),
    label: z.string().trim().max(120).optional(),
  })
  .strict();

export const createContentScriptInputSchema = z
  .object({
    workspaceId: z.uuid(),
    contentItemId: z.string().min(1).max(200),
    body: z.string().trim().min(1).max(40_000),
    language: z.string().trim().min(2).max(20),
    claims: z.array(claimSchema).max(100),
    beats: z.array(beatSchema).max(100),
    episodePlan: episodeSpecSchema.optional(),
    // An approved episode idea: the script is reviewed against its hook contract and the idea
    // moves to in_production.
    episodeIdeaId: z.string().min(1).max(200).optional(),
  })
  .strict();
export const approveContentScriptInputSchema = z
  .object({
    workspaceId: z.uuid(),
    scriptId: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const getContentScriptInputSchema = z
  .object({
    workspaceId: z.uuid(),
    scriptId: z.string().min(1).optional(),
    contentItemId: z.string().min(1).optional(),
    version: z.number().int().positive().optional(),
  })
  .strict()
  .refine((x) => !!x.scriptId !== !!x.contentItemId);

const resolveClaims = async (args: {
  workspaceId: ReturnType<typeof parseWorkspaceArgument> & {};
  contentItemId: string;
  claims: readonly ClaimInput[];
  deps: McpDependencies;
}) => {
  if (
    !args.workspaceId ||
    !args.deps.contentRepository ||
    !args.deps.offerRepository ||
    !args.deps.researchRepository
  )
    throw new Error("Editorial evidence dependencies are not configured.");
  const item = await args.deps.contentRepository.findContentItemForWorkspace({
    workspaceId: args.workspaceId,
    contentItemId: args.contentItemId,
  });
  if (!item) return { ok: false as const, unresolved: args.claims.map((_, index) => index) };
  const offer = item.offerId
    ? await args.deps.offerRepository.findForWorkspace({
        workspaceId: args.workspaceId,
        offerId: item.offerId,
      })
    : null;
  const unresolved: number[] = [];
  const expired: number[] = [];
  let unsupportedCommercialNumber: string | null = null;
  for (const [index, claim] of args.claims.entries()) {
    const citedFacts = [];
    for (const ref of claim.evidence as readonly EvidenceRef[]) {
      if (ref.kind === "commercial_fact") {
        const snapshot = offer?.snapshots.find((candidate) => candidate.id === ref.snapshotId);
        const fact = snapshot?.facts.find((candidate) => candidate.key === ref.key);
        if (item.offerSnapshotId !== ref.snapshotId || !fact) unresolved.push(index);
        else citedFacts.push(fact);
      } else {
        const observation = await args.deps.researchRepository.findObservationForWorkspace?.({
          workspaceId: args.workspaceId,
          observationId: ref.observationId,
        });
        if (!observation) unresolved.push(index);
        else if (observation.expiresAt < new Date()) expired.push(index);
      }
    }
    if (citedFacts.length)
      unsupportedCommercialNumber ??= numbersWithoutEvidence(claim.text, citedFacts)[0] ?? null;
  }
  return {
    ok: unresolved.length === 0,
    unresolved: [...new Set(unresolved)],
    expired: [...new Set(expired)],
    unsupportedCommercialNumber,
  };
};

export const createContentScriptTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createContentScriptInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.editorialRepository || !deps.contentRepository)
    throw new Error("Editorial dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const item = await deps.contentRepository.findContentItemForWorkspace({
    workspaceId,
    contentItemId: parsed.data.contentItemId,
  });
  if (!item) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const planViolation = parsed.data.episodePlan
    ? lintEpisode(parsed.data.episodePlan as EpisodeSpec)[0]
    : undefined;
  if (planViolation) return { ok: false, error: `EPISODE_PLAN_REJECTED:${planViolation}` };
  const claims = parsed.data.claims as readonly ClaimInput[];
  const niche = await deps.nicheRepository?.findForWorkspace({
    workspaceId,
    nicheId: item.nicheId,
  });
  const explainer = niche ? readExplainerContext(niche) : null;
  const { episodeIdeaId, ...scriptInput } = parsed.data;
  const idea = episodeIdeaId
    ? await deps.episodeIdeaRepository?.findForWorkspace({ workspaceId, ideaId: episodeIdeaId })
    : undefined;
  if (episodeIdeaId) {
    if (!deps.episodeIdeaRepository) throw new Error("Episode idea repository is not configured.");
    if (!idea) return { ok: false, error: "NOT_FOUND" };
    if (idea.nicheId !== item.nicheId)
      return { ok: false, error: "EPISODE_IDEA_REJECTED:niche_mismatch" };
    if (idea.status !== "approved" && idea.status !== "in_production")
      return { ok: false, error: "EPISODE_IDEA_REJECTED:idea_not_approved" };
    if (idea.contentItemId !== undefined && idea.contentItemId !== item.id)
      return { ok: false, error: "EPISODE_IDEA_REJECTED:idea_in_production_elsewhere" };
  }
  const beats = parsed.data.beats.map(({ label, ...beat }) =>
    label === undefined ? beat : { ...beat, label },
  );
  const explainerVerdict = explainer
    ? validateExplainerScript({
        body: parsed.data.body,
        language: parsed.data.language,
        claims: withClaimKindDefault(claims),
        beats,
        targetSeconds: explainer.targetSeconds,
      })
    : null;
  // Only media niches may state simplifications, analogies or examples; affiliate claims stay
  // evidence-backed facts so no unsourced price or result claim reaches approval.
  if (
    !explainer &&
    claims.some(
      (claim) =>
        (claim.kind !== undefined && claim.kind !== "verified_fact") || claim.evidence.length === 0,
    )
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  if (explainerVerdict && !explainerVerdict.ok)
    return { ok: false, error: `EXPLAINER_SCRIPT_REJECTED:${explainerVerdict.reason}` };
  const resolution = await resolveClaims({ workspaceId, contentItemId: item.id, claims, deps });
  if (!resolution.ok) return { ok: false, error: `CLAIM_UNRESOLVED:${resolution.unresolved[0]}` };
  if (resolution.unsupportedCommercialNumber)
    return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${resolution.unsupportedCommercialNumber}` };
  const version = await deps.editorialRepository.nextScriptVersion({
    workspaceId,
    contentItemId: item.id,
  });
  try {
    const script = createContentScript({
      ...scriptInput,
      workspaceId,
      actorId,
      version,
      claims,
      beats,
      episodePlan: parsed.data.episodePlan as EpisodeSpec | undefined,
    });
    const created = await deps.editorialRepository.createScript(script);
    await deps.audit?.record({
      action: "content.script.created",
      workspaceId,
      actorUserId: actorId,
      targetType: "ContentScript",
      targetId: created.id,
      metadata: {
        contentItemId: item.id,
        version,
        checksum: created.checksum,
        ...(idea ? { episodeIdeaId: idea.id } : {}),
      },
    });
    if (idea?.status === "approved")
      await deps.episodeIdeaRepository?.save(startProduction(idea, item.id, new Date()));
    const variant = idea?.packaging?.find((v) => v.id === idea.selectedVariantId);
    const forbiddenPhrases = niche ? (readPackagingProfile(niche)?.forbiddenPhrases ?? []) : [];
    return {
      ok: true,
      value: {
        scriptId: created.id,
        version,
        checksum: created.checksum,
        unresolved: [],
        warnings: resolution.expired.map((index) => `evidence_expired:${index}`),
        ...(explainerVerdict?.ok
          ? {
              estimatedSeconds: explainerVerdict.estimatedSeconds,
              hookType: explainerVerdict.hookType,
            }
          : {}),
        ...(idea?.hookContract && variant
          ? {
              forbiddenPhrases,
              hookReview: reviewHook({
                script: created,
                contract: idea.hookContract,
                variant,
                forbiddenPhrases,
              }),
            }
          : {}),
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "SCRIPT_VERSION_CONFLICT")
      return { ok: false, error: "SCRIPT_VERSION_CONFLICT" };
    if (error instanceof Error && error.message === "invalid_content_script")
      return { ok: false, error: "INVALID_CONTENT" };
    if (error instanceof Error && error.message === "invalid_claim")
      return { ok: false, error: "INVALID_ARGUMENTS" };
    throw error;
  }
};

export const approveContentScriptTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = approveContentScriptInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.editorialRepository || !deps.contentRepository)
    throw new Error("Editorial dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const script = await deps.editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: parsed.data.scriptId,
  });
  if (!script) return { ok: false, error: "CONTENT_NOT_FOUND" };
  if (script.status === "approved") return { ok: false, error: "SCRIPT_ALREADY_APPROVED" };
  if (script.checksum !== parsed.data.checksum)
    return { ok: false, error: "SCRIPT_BINDING_MISMATCH" };
  const resolution = await resolveClaims({
    workspaceId,
    contentItemId: script.contentItemId,
    claims: script.claims,
    deps,
  });
  if (!resolution.ok) return { ok: false, error: `CLAIM_UNRESOLVED:${resolution.unresolved[0]}` };
  if (resolution.unsupportedCommercialNumber)
    return { ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${resolution.unsupportedCommercialNumber}` };
  const approvedAt = new Date();
  const approved = await deps.editorialRepository.approveDraft({
    workspaceId,
    scriptId: script.id,
    checksum: script.checksum,
    actorId,
    approvedAt,
  });
  if (!approved) {
    const fresh = await deps.editorialRepository.findScriptForWorkspace({
      workspaceId,
      scriptId: script.id,
    });
    return {
      ok: false,
      error: fresh?.status === "approved" ? "SCRIPT_ALREADY_APPROVED" : "SCRIPT_BINDING_MISMATCH",
    };
  }
  await deps.audit?.record({
    action: "content.script.approved",
    workspaceId,
    actorUserId: actorId,
    targetType: "ContentScript",
    targetId: script.id,
    metadata: { version: script.version, checksum: script.checksum },
  });
  return {
    ok: true,
    value: {
      status: approved.status,
      approvedAt: approvedAt.toISOString(),
      warnings: resolution.expired.map((index) => `evidence_expired:${index}`),
    },
  };
};

export const getContentScriptTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getContentScriptInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.editorialRepository || !deps.contentRepository)
    throw new Error("Editorial dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const script = parsed.data.scriptId
    ? await deps.editorialRepository.findScriptForWorkspace({
        workspaceId,
        scriptId: parsed.data.scriptId,
      })
    : parsed.data.contentItemId
      ? await deps.editorialRepository.findScriptVersion({
          workspaceId,
          contentItemId: parsed.data.contentItemId,
          ...(parsed.data.version !== undefined ? { version: parsed.data.version } : {}),
        })
      : null;
  if (!script) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const claims = [];
  for (const claim of script.claims) {
    const evidence = [];
    for (const ref of claim.evidence) {
      if (ref.kind === "research_observation") {
        const resolved = await deps.researchRepository?.findObservationForWorkspace?.({
          workspaceId,
          observationId: ref.observationId,
        });
        evidence.push(
          resolved
            ? { ...ref, sourceUrl: resolved.sourceUrl, value: resolved.value }
            : { ...ref, unresolved: true },
        );
      } else {
        const item = await deps.contentRepository.findContentItemForWorkspace({
          workspaceId,
          contentItemId: script.contentItemId,
        });
        const offer = item?.offerId
          ? await deps.offerRepository?.findForWorkspace({ workspaceId, offerId: item.offerId })
          : null;
        const fact = offer?.snapshots
          .find((x) => x.id === ref.snapshotId)
          ?.facts.find((x) => x.key === ref.key);
        evidence.push(
          fact
            ? { ...ref, value: fact.value, sourceUrl: fact.sourceUrl }
            : { ...ref, unresolved: true },
        );
      }
    }
    // Kind and note let a reviewer tell a sourced fact from an analogy before approving.
    claims.push({
      text: claim.text,
      kind: claim.kind,
      ...(claim.note ? { note: claim.note } : {}),
      evidence,
    });
  }
  return { ok: true, value: { script: { ...script, claims } } };
};
