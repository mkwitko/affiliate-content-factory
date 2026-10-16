import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import {
  brandAssetComplete,
  brandAssetFields,
  brandAssetMetadata,
  storeFetchedImage,
} from "./import-asset-from-url.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

// `file` is the Apps SDK file reference ChatGPT fills in (see `fileParams` in server.ts).
// It stays required and exactly these four fields: an optional or open file schema is
// reported to make ChatGPT drop the file (openai/openai-apps-sdk-examples#237).
export const importAssetFromFileInputSchema = z
  .object({
    workspaceId: z.uuid(),
    file: z
      .object({
        // Plain strings, no `format`/`minLength`: the exact documented shape.
        download_url: z.string(),
        file_id: z.string(),
        mime_type: z.string().optional(),
        file_name: z.string().optional(),
      })
      .strict(),
    source: z.enum(["generated", "operator_upload"]),
    width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(),
    license: z.string().trim().min(1).max(500),
    commercialUse: z.union([z.boolean(), z.null()]).optional(),
    sourceUrl: z.url().optional(),
    creator: z.string().trim().min(1).max(200).optional(),
    ...brandAssetFields,
  })
  .strict()
  .refine((input) => (input.width === undefined) === (input.height === undefined))
  .refine(brandAssetComplete);

export const importAssetFromFileTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = importAssetFromFileInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  if (!URL.canParse(parsed.data.file.download_url) || !parsed.data.file.file_id)
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const { width, height } = parsed.data;
  const metadata = brandAssetMetadata(parsed.data);
  return storeFetchedImage(deps, {
    workspaceId,
    url: new URL(parsed.data.file.download_url),
    canvas: width !== undefined && height !== undefined ? { width, height } : undefined,
    // A finished slide fills the canvas; the centred overflow is trimmed, never letterboxed.
    fit: "cover",
    provenance: parsed.data.source,
    license: parsed.data.license,
    ...(parsed.data.commercialUse !== undefined
      ? { commercialUse: parsed.data.commercialUse }
      : {}),
    ...(parsed.data.sourceUrl ? { sourceUrl: parsed.data.sourceUrl } : {}),
    ...(parsed.data.creator ? { creator: parsed.data.creator } : {}),
    ...(metadata ? { metadata } : {}),
  });
};
