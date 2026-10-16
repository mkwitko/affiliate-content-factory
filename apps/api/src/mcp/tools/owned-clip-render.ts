import { createHash } from "node:crypto";
import { isVerticalLayout, OWNED_CLIP_LAYOUTS } from "@money-maker/core/assets/clip-renderer";
import { createAsset } from "@money-maker/core/assets/asset";
import { createRenderOwnedClipJob } from "@money-maker/core/jobs/job";
import { refineOwnedClipBoundaries } from "@money-maker/core/publishing/owned-clip-boundaries";
import { buildOwnedClipCaptionWords } from "@money-maker/core/publishing/owned-clip-captions";
import type { UserId } from "@money-maker/contracts";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const renderOwnedClipInputSchema = z
  .object({
    workspaceId: z.uuid(),
    sourceRenderId: z.string().min(1).max(200),
    childContentItemId: z.string().min(1).max(200),
    fromChar: z.number().int().nonnegative(),
    toChar: z.number().int().positive(),
    layout: z.enum(OWNED_CLIP_LAYOUTS).default("source"),
    captionTreatment: z.enum(["inherit", "adaptive"]).default("inherit"),
    origin: z.enum(["designed", "discovered"]),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();
export const getOwnedClipRenderInputSchema = z
  .object({ workspaceId: z.uuid(), assetId: z.string().min(1).max(200) })
  .strict();

const hashRequest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestAssetId = (requestKey: string, attempt: number) => {
  const hex = hashRequest(`${requestKey}:${attempt}`).slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

export const renderOwnedClipTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = renderOwnedClipInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.contentRepository ||
    !deps.storyboardRepository ||
    !deps.editorialRepository ||
    !deps.longFormRenderRepository ||
    !deps.assetRepository ||
    !deps.assetStore ||
    !deps.jobQueue
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  if (parsed.data.captionTreatment === "adaptive" && !isVerticalLayout(parsed.data.layout))
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;

  const [child, render] = await Promise.all([
    deps.contentRepository.findContentItemForWorkspace({
      workspaceId,
      contentItemId: parsed.data.childContentItemId,
    }),
    deps.longFormRenderRepository.findForWorkspace({
      workspaceId,
      renderId: parsed.data.sourceRenderId,
    }),
  ]);
  if (!child || !render || render.status !== "ready" || !render.timingManifest)
    return { ok: false, error: "CLIP_TIMING_UNAVAILABLE" };
  if (child.state !== "draft" || child.offerId !== null)
    return { ok: false, error: "INVALID_CONTENT" };
  const board = await deps.storyboardRepository.findForWorkspace({
    workspaceId,
    storyboardId: render.storyboardId,
  });
  if (!board || child.sourceContentItemId !== board.contentItemId)
    return { ok: false, error: "SCRIPT_BINDING_MISMATCH" };
  const script = await deps.editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: render.timingManifest.scriptId,
  });
  if (
    !script ||
    script.status !== "approved" ||
    script.checksum !== render.timingManifest.scriptChecksum ||
    board.scriptId !== script.id
  )
    return { ok: false, error: "SCRIPT_BINDING_MISMATCH" };

  let boundaries: ReturnType<typeof refineOwnedClipBoundaries>;
  try {
    boundaries = refineOwnedClipBoundaries({
      manifest: render.timingManifest,
      fromChar: parsed.data.fromChar,
      toChar: parsed.data.toChar,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message === "clip_semantic_span_unmatched"
          ? "CLIP_SPAN_UNMATCHED"
          : error instanceof Error && error.message === "clip_duration_invalid"
            ? "CLIP_DURATION_INVALID"
            : "CLIP_TIMING_UNAVAILABLE",
    };
  }

  const masterHasNoCaptions =
    board.scenes.length > 0 && board.scenes.every((scene) => scene.captionMode === "none");
  const canAdaptCaptions =
    parsed.data.captionTreatment === "adaptive" &&
    masterHasNoCaptions &&
    (buildOwnedClipCaptionWords({
      manifest: render.timingManifest,
      startMs: boundaries.startMs,
      endMs: boundaries.endMs,
    })?.length ?? 0) > 0;
  const captionTreatment =
    parsed.data.captionTreatment !== "adaptive"
      ? "inherited"
      : canAdaptCaptions
        ? "adapted"
        : masterHasNoCaptions
          ? "unavailable"
          : "inherited";

  const source = await deps.assetRepository.findForWorkspace({
    workspaceId,
    assetId: render.timingManifest.renderedAssetId,
  });
  if (
    !source ||
    source.state !== "active" ||
    source.mimeType !== "video/mp4" ||
    source.checksum !== render.timingManifest.renderedAssetChecksum
  )
    return { ok: false, error: "CLIP_TIMING_UNAVAILABLE" };

  // A portrait source has nothing to blur or crop; `vertical` is its identity fit and keeps the
  // adaptive-caption and variant paths working.
  const layout =
    (parsed.data.layout === "vertical_blur" || parsed.data.layout === "vertical_focus") &&
    source.height >= source.width
      ? "vertical"
      : parsed.data.layout;
  const requestParts = [workspaceId, child.id, render.id, boundaries.fromChar, boundaries.toChar];
  if (layout === "vertical_blur" || layout === "vertical_focus")
    requestParts.push(`layout:${layout}`);
  if (parsed.data.captionTreatment === "adaptive")
    requestParts.push(`captionTreatment:${captionTreatment}`);
  const requestKey = hashRequest(requestParts.join(":"));
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const assetId = requestAssetId(requestKey, attempt);
    const existing = await deps.assetRepository.findForWorkspace({ workspaceId, assetId });
    if (existing) {
      const state = existing.metadata?.renderStatus;
      if (state !== "failed")
        return {
          ok: true,
          value: {
            assetId,
            attempt,
            status: state === "ready" ? "ready" : "pending",
            captionTreatment: existing.metadata?.captionTreatment ?? "inherited",
            ...boundaries,
          },
        };
      continue;
    }
    const pending = createAsset({
      id: assetId,
      workspaceId,
      mimeType: "video/mp4",
      checksum: "0".repeat(64),
      durationMs: boundaries.durationMs,
      width: isVerticalLayout(layout) ? 1080 : source.width,
      height: isVerticalLayout(layout) ? 1920 : source.height,
      provenance: "rendered",
      license: "Rendered from a workspace-owned long-form asset",
      commercialUse: null,
      metadata: {
        role: "owned_clip",
        renderStatus: "pending",
        requestKey,
        attempt,
        sourceAssetIds: [source.id],
        sourceContentItemId: board.contentItemId,
        derivedContentItemId: child.id,
        sourceRenderId: render.id,
        sourceAssetChecksum: source.checksum,
        sourceStartMs: boundaries.startMs,
        sourceEndMs: boundaries.endMs,
        fromChar: boundaries.fromChar,
        toChar: boundaries.toChar,
        layout,
        origin: parsed.data.origin,
        rationale: parsed.data.rationale,
        captionTreatment,
      },
    });
    if (!pending.ok) return { ok: false, error: "INVALID_CONTENT" };
    try {
      await deps.assetRepository.create(pending.asset);
    } catch {
      const raced = await deps.assetRepository.findForWorkspace({ workspaceId, assetId });
      if (raced)
        return {
          ok: true,
          value: {
            assetId,
            attempt,
            status: "pending",
            captionTreatment: raced.metadata?.captionTreatment ?? "inherited",
            ...boundaries,
          },
        };
      return { ok: false, error: "INTERNAL_ERROR" };
    }
    try {
      await deps.jobQueue.enqueue(createRenderOwnedClipJob({ workspaceId, assetId }));
    } catch {
      await deps.assetRepository.updateMetadata?.({
        workspaceId,
        assetId,
        patch: { renderStatus: "failed", renderFailureReason: "job_queue_unavailable" },
      });
      return { ok: false, error: "JOB_QUEUE_UNAVAILABLE" };
    }
    return {
      ok: true,
      value: { assetId, attempt, status: "pending", captionTreatment, ...boundaries },
    };
  }
  return { ok: false, error: "CLIP_DURATION_INVALID" };
};

export const getOwnedClipRenderTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getOwnedClipRenderInputSchema.safeParse(args);
  if (!parsed.success || !deps.assetRepository) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const asset = await deps.assetRepository.findForWorkspace({
    workspaceId,
    assetId: parsed.data.assetId,
  });
  if (!asset || asset.metadata?.role !== "owned_clip")
    return { ok: false, error: "CONTENT_NOT_FOUND" };
  const status = asset.metadata.renderStatus;
  const previewUrl =
    status === "ready" && deps.assetStore
      ? ((
          await deps.assetStore.createDownload({ workspaceId, assetId: asset.id }).catch(() => null)
        )?.url ?? null)
      : null;
  return {
    ok: true,
    value: {
      assetId: asset.id,
      status: status === "ready" ? "ready" : status === "failed" ? "failed" : "pending",
      ...(typeof asset.metadata.renderFailureReason === "string"
        ? { reason: asset.metadata.renderFailureReason }
        : {}),
      ...(status === "ready" ? { durationMs: asset.durationMs, previewUrl } : {}),
      sourceRenderId: asset.metadata.sourceRenderId,
      origin: asset.metadata.origin,
      captionTreatment: asset.metadata.captionTreatment ?? "inherited",
    },
  };
};
