import { createHash } from "node:crypto";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { createAsset } from "@money-maker/core/assets/asset";
import { fitImage, isBlankImage } from "@money-maker/providers/http/fit-image";
import { CanvaExportError } from "@money-maker/providers/canva/client";
import type { McpDependencies, ToolResult } from "../server.js";
import type { ToolErrorCode } from "../tool-result.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const syncCanvaDesignInputSchema = z
  .object({
    workspaceId: z.uuid(),
    designId: z.string().trim().min(1).max(200),
    pages: z.array(z.number().int().positive()).min(1).max(50).optional(),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
  })
  .strict();

// Page-selection failures raised by CanvaDesignExporter before or after the Canva job.
const exporterPageErrors = new Set(["page_export_missing", "invalid_page_selection"]);

// Download and validation failures of an exported page (fetchSafeMedia, fitImage): the page
// itself is unusable, typically an expired export URL, so the operator re-syncs.
const exportedPageErrors = new Set([
  "media_fetch_failed",
  "mime_not_allowed",
  "media_too_large",
  "media_truncated",
  "url_not_public",
  "unsupported_image",
]);

const mapExporterError = (error: unknown): ToolErrorCode => {
  const message = error instanceof Error ? error.message : "";
  if (message === "canva_not_connected") return "CANVA_NOT_CONNECTED";
  if (message === "canva_token_invalid") return "CANVA_TOKEN_INVALID";
  if (message === "canva_export_timed_out") return "CANVA_EXPORT_TIMED_OUT";
  if (exportedPageErrors.has(message)) return "INVALID_CONTENT";
  // Canva answered and refused (request rejected, poll failed, job error code, missing page):
  // the operator has to look at the design, not at the connection.
  if (error instanceof CanvaExportError || exporterPageErrors.has(message)) {
    return "CANVA_EXPORT_FAILED";
  }
  return "CONNECTION_UNAVAILABLE";
};

export const syncCanvaDesignTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = syncCanvaDesignInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.designExporterForWorkspace || !deps.assetRepository || !deps.assetStore)
    throw new Error("Canva dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;

  const { designId, width, height } = parsed.data;
  // ponytail: defaults to the design's first page when `pages` is omitted; pass an explicit
  // array to export a multi-slide/carousel design.
  const pages = parsed.data.pages ?? [1];

  const exporter = deps.designExporterForWorkspace(workspaceId);
  let exported: Awaited<ReturnType<typeof exporter.exportPages>>;
  try {
    exported = await exporter.exportPages({ designId, pages, format: "png" });
  } catch (error) {
    return { ok: false, error: mapExporterError(error) };
  }

  // Check every page before storing any, so a blank page never leaves a half-synced design.
  for (const page of exported) {
    if (await isBlankImage(page.bytes)) return { ok: false, error: "CANVA_PAGE_BLANK" };
  }

  const assetIds: string[] = [];
  for (const page of exported) {
    if (page.expiresAt <= new Date()) return { ok: false, error: "INVALID_CONTENT" };
    // Same asset pipeline as import_asset_from_url: never trust the provider's own
    // reported dimensions, measure the real bytes and letterbox onto the canvas.
    const image = await fitImage(page.bytes, { width, height });
    const created = createAsset({
      workspaceId,
      mimeType: image.mimeType,
      checksum: createHash("sha256").update(image.bytes).digest("hex"),
      width: image.width,
      height: image.height,
      provenance: "provider_import",
      license: "Canva design export",
    });
    if (!created.ok) return { ok: false, error: "INVALID_CONTENT" };
    await deps.assetStore.putObject({
      workspaceId,
      assetId: created.asset.id,
      mimeType: image.mimeType,
      checksum: created.asset.checksum,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
    });
    const stored = await deps.assetRepository.create(created.asset);
    const active = await deps.assetRepository.updateState({
      workspaceId,
      assetId: stored.id,
      state: "active",
    });
    assetIds.push((active ?? stored).id);
  }

  return { ok: true, value: { designId, assetIds } };
};
