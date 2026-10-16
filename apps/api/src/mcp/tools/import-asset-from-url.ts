import { createHash } from "node:crypto";
import { z } from "zod";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import { createAsset, type AssetProvenance } from "@money-maker/core/assets/asset";
import {
  EXPLAINER_ART_STYLES,
  type ExplainerArtStyle,
  explainerBackgroundKey,
} from "@money-maker/core/explainer/background-art";
import { BACKGROUNDS, type BackgroundId } from "@money-maker/core/explainer/backgrounds";
import { fitImage } from "@money-maker/providers/http/fit-image";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
// Brand assets (a niche logo, a recurring character sheet) are tagged so they can be reused by
// id and served at a stable public URL (GET /v1/public/workspaces/:workspaceId/assets/:assetId).
export const brandAssetFields = {
  role: z.enum(["logo", "character", "explainer_background"]).optional(),
  label: z.string().trim().min(1).max(120).optional(),
  nicheId: z.uuid().optional(),
  // role explainer_background: the procedural setting the painting replaces, and its style.
  setting: z.enum(BACKGROUNDS).optional(),
  style: z.enum(EXPLAINER_ART_STYLES).optional(),
};
type BrandAssetInput = Readonly<{
  role?: "logo" | "character" | "explainer_background" | undefined;
  label?: string | undefined;
  nicheId?: string | undefined;
  setting?: BackgroundId | undefined;
  style?: ExplainerArtStyle | undefined;
}>;
/** A painted background needs its niche, setting and style: that is its bank key. */
export const brandAssetComplete = (input: BrandAssetInput): boolean =>
  input.role !== "explainer_background" ||
  (input.nicheId !== undefined && input.setting !== undefined && input.style !== undefined);
export const brandAssetMetadata = (
  input: BrandAssetInput,
): Readonly<Record<string, unknown>> | undefined => {
  if (!input.role) return undefined;
  if (input.role === "explainer_background" && input.nicheId && input.setting && input.style)
    return {
      role: input.role,
      nicheId: input.nicheId,
      setting: input.setting,
      style: input.style,
      sceneKey: explainerBackgroundKey(input.nicheId, {
        setting: input.setting,
        style: input.style,
      }),
      usageCount: 0,
      lastUsedAt: null,
      ...(input.label ? { label: input.label } : {}),
    };
  return {
    role: input.role,
    ...(input.label ? { label: input.label } : {}),
    ...(input.nicheId ? { nicheId: input.nicheId } : {}),
  };
};
export const publicAssetUrl = (
  publicApiUrl: string | undefined,
  workspaceId: WorkspaceId,
  assetId: string,
): string | undefined =>
  publicApiUrl
    ? `${publicApiUrl.replace(/\/$/, "")}/v1/public/workspaces/${workspaceId}/assets/${assetId}`
    : undefined;

export const importAssetFromUrlInputSchema = z
  .object({
    workspaceId: z.uuid(),
    url: z.url(),
    width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(),
    license: z.string().trim().min(1).max(500),
    ...brandAssetFields,
  })
  .strict()
  .refine((input) => (input.width === undefined) === (input.height === undefined))
  .refine(brandAssetComplete);
export const importAssetFromUrlTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = importAssetFromUrlInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.assetRepository || !deps.assetStore)
    throw new Error("Asset dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const { width, height } = parsed.data;
  const metadata = brandAssetMetadata(parsed.data);
  return storeFetchedImage(deps, {
    workspaceId,
    url: new URL(parsed.data.url),
    canvas: width !== undefined && height !== undefined ? { width, height } : undefined,
    fit: "contain",
    provenance: "provider_import",
    license: parsed.data.license,
    ...(metadata ? { metadata } : {}),
  });
};

// Fetches public image bytes, fits them to an optional canvas, and stores an active asset.
export const storeFetchedImage = async (
  deps: McpDependencies,
  input: Readonly<{
    workspaceId: WorkspaceId;
    url: URL;
    canvas: Readonly<{ width: number; height: number }> | undefined;
    fit: "contain" | "cover";
    provenance: AssetProvenance;
    license: string;
    commercialUse?: boolean | null;
    sourceUrl?: string;
    creator?: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): Promise<ToolResult> => {
  if (!deps.assetRepository || !deps.assetStore)
    throw new Error("Asset dependencies are not configured.");
  const { workspaceId } = input;
  try {
    const media = await fetchSafeMedia(input.url, {
      maxBytes: 10_000_000,
      allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    const image = await fitImage(media.bytes, input.canvas, input.fit);
    const created = createAsset({
      workspaceId,
      mimeType: image.mimeType,
      checksum: createHash("sha256").update(image.bytes).digest("hex"),
      byteSize: image.bytes.byteLength,
      width: image.width,
      height: image.height,
      provenance: input.provenance,
      license: input.license,
      commercialUse: input.commercialUse ?? null,
      sourceUrl: input.sourceUrl ?? input.url.toString(),
      ...(input.creator ? { creator: input.creator } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
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
    const role = input.metadata?.role;
    const publicUrl =
      role === "logo" || role === "character"
        ? publicAssetUrl(deps.publicApiUrl, workspaceId, stored.id)
        : undefined;
    return { ok: true, value: { asset: active ?? stored, ...(publicUrl ? { publicUrl } : {}) } };
  } catch {
    return { ok: false, error: "INVALID_CONTENT" };
  }
};
