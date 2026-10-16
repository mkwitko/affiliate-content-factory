import type { UserId } from "@money-maker/contracts";
import {
  refineOwnedClipBoundaries,
  refineOwnedClipTimeRange,
} from "@money-maker/core/publishing/owned-clip-boundaries";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const renderInput = z
  .object({ workspaceId: z.uuid(), renderId: z.string().min(1).max(200) })
  .strict();
export const getLongFormTimingInputSchema = renderInput;
export const refineOwnedClipBoundariesInputSchema = renderInput
  .extend({ fromChar: z.number().int().nonnegative(), toChar: z.number().int().positive() })
  .strict();
export const refineOwnedClipTimeRangeInputSchema = renderInput
  .extend({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive() })
  .strict();

const readReadyManifest = async (
  workspaceId: NonNullable<ReturnType<typeof parseWorkspaceArgument>>,
  renderId: string,
  actorId: UserId,
  deps: McpDependencies,
) => {
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return { error: denied } as const;
  if (!deps.longFormRenderRepository) return { error: "unavailable" } as const;
  const render = await deps.longFormRenderRepository.findForWorkspace({ workspaceId, renderId });
  if (!render) return { error: "not_found" } as const;
  if (render.status !== "ready" || !render.timingManifest)
    return { error: "timing_unavailable" } as const;
  return { manifest: render.timingManifest, render } as const;
};

export const getLongFormTimingTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getLongFormTimingInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const result = await readReadyManifest(workspaceId, parsed.data.renderId, actorId, deps);
  if ("error" in result) {
    if (typeof result.error === "object") return result.error;
    return {
      ok: false,
      error:
        result.error === "not_found"
          ? "CONTENT_NOT_FOUND"
          : result.error === "timing_unavailable"
            ? "CLIP_TIMING_UNAVAILABLE"
            : "INVALID_ARGUMENTS",
    };
  }
  const { manifest } = result;
  return {
    ok: true,
    value: {
      renderId: manifest.renderId,
      scriptId: manifest.scriptId,
      scriptChecksum: manifest.scriptChecksum,
      alignmentStatus: manifest.alignmentStatus,
      durationMs: manifest.durationMs,
      scenes: manifest.scenes,
      words: manifest.words,
    },
  };
};

export const refineOwnedClipBoundariesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = refineOwnedClipBoundariesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const result = await readReadyManifest(workspaceId, parsed.data.renderId, actorId, deps);
  if ("error" in result) {
    if (typeof result.error === "object") return result.error;
    return {
      ok: false,
      error:
        result.error === "not_found"
          ? "CONTENT_NOT_FOUND"
          : result.error === "timing_unavailable"
            ? "CLIP_TIMING_UNAVAILABLE"
            : "INVALID_ARGUMENTS",
    };
  }
  try {
    const boundaries = refineOwnedClipBoundaries({
      manifest: result.manifest,
      fromChar: parsed.data.fromChar,
      toChar: parsed.data.toChar,
    });
    return {
      ok: true,
      value: {
        renderId: result.manifest.renderId,
        scriptId: result.manifest.scriptId,
        scriptChecksum: result.manifest.scriptChecksum,
        renderedAssetId: result.manifest.renderedAssetId,
        renderedAssetChecksum: result.manifest.renderedAssetChecksum,
        ...boundaries,
      },
    };
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
};

export const refineOwnedClipTimeRangeTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = refineOwnedClipTimeRangeInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const result = await readReadyManifest(workspaceId, parsed.data.renderId, actorId, deps);
  if ("error" in result) {
    if (typeof result.error === "object") return result.error;
    return {
      ok: false,
      error:
        result.error === "not_found"
          ? "CONTENT_NOT_FOUND"
          : result.error === "timing_unavailable"
            ? "CLIP_TIMING_UNAVAILABLE"
            : "INVALID_ARGUMENTS",
    };
  }
  try {
    const boundaries = refineOwnedClipTimeRange({
      manifest: result.manifest,
      startMs: parsed.data.startMs,
      endMs: parsed.data.endMs,
    });
    return {
      ok: true,
      value: {
        renderId: result.manifest.renderId,
        scriptId: result.manifest.scriptId,
        scriptChecksum: result.manifest.scriptChecksum,
        requestedStartMs: parsed.data.startMs,
        requestedEndMs: parsed.data.endMs,
        ...boundaries,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message === "clip_time_range_invalid"
          ? "CLIP_TIME_RANGE_INVALID"
          : error instanceof Error && error.message === "clip_semantic_span_unmatched"
            ? "CLIP_SPAN_UNMATCHED"
            : error instanceof Error && error.message === "clip_duration_invalid"
              ? "CLIP_DURATION_INVALID"
              : "CLIP_TIMING_UNAVAILABLE",
    };
  }
};
