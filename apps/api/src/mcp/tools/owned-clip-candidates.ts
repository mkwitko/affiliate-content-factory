import type { UserId, WorkspaceId } from "@money-maker/contracts";
import {
  buildCandidateWindows,
  CANDIDATE_SIGNALS,
  evaluateOwnedClipCandidates,
  OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
} from "@money-maker/core/publishing/owned-clip-candidates";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const renderInput = z
  .object({ workspaceId: z.uuid(), renderId: z.string().min(1).max(200) })
  .strict();
export const suggestOwnedClipCandidatesInputSchema = renderInput
  .extend({
    count: z.number().int().min(3).max(8).optional(),
    targetSec: z
      .object({ min: z.number().int().min(10), max: z.number().int().max(180) })
      .strict()
      .refine((range) => range.min < range.max)
      .optional(),
  })
  .strict();
export const recordOwnedClipCandidatesInputSchema = renderInput
  .extend({
    promptVersion: z.string().min(1).max(100),
    candidates: z
      .array(
        z
          .object({
            fromChar: z.number().int().nonnegative(),
            toChar: z.number().int().positive(),
            title: z.string().trim().min(1).max(80),
            hook: z.string().min(1).max(300),
            reason: z.string().trim().min(1).max(200),
            signals: z.array(z.enum(CANDIDATE_SIGNALS)).max(CANDIDATE_SIGNALS.length),
            score: z.number().min(0).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();

const DEFAULT_COUNT = 5;
const MAX_KEPT = 8;
const rules = [
  "Pick self-contained mini-arcs: a hook, the point, and a payoff inside the span.",
  "fromChar/toChar are character offsets into the script body; never paraphrase the script.",
  "hook is the exact script sentence that opens the span and must start within its first 40 characters.",
  "Aim for 30-60 seconds; 15-90 seconds is tolerated, under 10 or over 180 is dropped.",
  "title and hook are suggestions for the owner, not claims. Do not invent facts, prices or results.",
  "score is 0-100, your own opinion; signals name why it works.",
];

const loadReadyRender = async (
  parsed: { workspaceId: string; renderId: string },
  actorId: UserId,
  deps: McpDependencies,
  roles: readonly ("owner" | "operator" | "reviewer")[],
): Promise<
  | { error: ToolResult }
  | {
      workspaceId: WorkspaceId;
      manifest: NonNullable<
        Awaited<
          ReturnType<NonNullable<McpDependencies["longFormRenderRepository"]>["findForWorkspace"]>
        >
      >["timingManifest"] &
        object;
      body: string;
      assetId: string;
      cached: Record<string, unknown> | null;
    }
> => {
  const workspaceId = parseWorkspaceArgument(parsed.workspaceId);
  if (!workspaceId) return { error: { ok: false, error: "INVALID_ARGUMENTS" } };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, roles);
  if (denied) return { error: denied };
  if (!deps.longFormRenderRepository || !deps.editorialRepository || !deps.assetRepository)
    return { error: { ok: false, error: "CONNECTION_UNAVAILABLE" } };
  const render = await deps.longFormRenderRepository.findForWorkspace({
    workspaceId,
    renderId: parsed.renderId,
  });
  if (!render) return { error: { ok: false, error: "CONTENT_NOT_FOUND" } };
  if (render.status !== "ready" || !render.timingManifest || !render.assetId)
    return { error: { ok: false, error: "CLIP_TIMING_UNAVAILABLE" } };
  const manifest = render.timingManifest;
  const [script, asset] = await Promise.all([
    deps.editorialRepository.findScriptForWorkspace({ workspaceId, scriptId: manifest.scriptId }),
    deps.assetRepository.findForWorkspace({ workspaceId, assetId: render.assetId }),
  ]);
  if (
    !script ||
    script.status !== "approved" ||
    script.checksum !== manifest.scriptChecksum ||
    !asset ||
    asset.state !== "active" ||
    asset.checksum !== manifest.renderedAssetChecksum
  )
    return { error: { ok: false, error: "SCRIPT_BINDING_MISMATCH" } };
  const stored = asset.metadata?.ownedClipCandidates;
  const cached =
    typeof stored === "object" &&
    stored !== null &&
    (stored as Record<string, unknown>).promptVersion === OWNED_CLIP_CANDIDATE_PROMPT_VERSION &&
    (stored as Record<string, unknown>).manifestChecksum === manifest.manifestChecksum
      ? (stored as Record<string, unknown>)
      : null;
  return { workspaceId, manifest, body: script.body, assetId: asset.id, cached };
};

export const suggestOwnedClipCandidatesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = suggestOwnedClipCandidatesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const loaded = await loadReadyRender(parsed.data, actorId, deps, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if ("error" in loaded) return loaded.error;
  if (loaded.cached)
    return {
      ok: true,
      value: {
        cached: true,
        promptVersion: OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
        candidates: loaded.cached.candidates as never,
      },
    };
  return {
    ok: true,
    value: {
      cached: false,
      promptVersion: OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
      count: parsed.data.count ?? DEFAULT_COUNT,
      targetSec: parsed.data.targetSec ?? { min: 30, max: 60 },
      rules,
      windows: buildCandidateWindows(loaded.manifest, loaded.body),
    },
  };
};

export const recordOwnedClipCandidatesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = recordOwnedClipCandidatesInputSchema.safeParse(args);
  if (!parsed.success || parsed.data.promptVersion !== OWNED_CLIP_CANDIDATE_PROMPT_VERSION)
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const loaded = await loadReadyRender(parsed.data, actorId, deps, ["owner", "operator"]);
  if ("error" in loaded) return loaded.error;
  if (loaded.cached)
    return {
      ok: true,
      value: {
        cached: true,
        promptVersion: OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
        candidates: loaded.cached.candidates as never,
        dropped: [],
      },
    };
  const { kept, dropped } = evaluateOwnedClipCandidates({
    manifest: loaded.manifest,
    scriptBody: loaded.body,
    candidates: parsed.data.candidates,
    count: MAX_KEPT,
  });
  if (kept.length > 0)
    await deps.assetRepository?.updateMetadata?.({
      workspaceId: loaded.workspaceId,
      assetId: loaded.assetId,
      patch: {
        ownedClipCandidates: {
          promptVersion: OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
          manifestChecksum: loaded.manifest.manifestChecksum,
          createdAt: new Date().toISOString(),
          candidates: kept,
        },
      },
    });
  return {
    ok: true,
    value: {
      cached: false,
      promptVersion: OWNED_CLIP_CANDIDATE_PROMPT_VERSION,
      candidates: kept as never,
      dropped,
    },
  };
};
