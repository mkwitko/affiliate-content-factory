import type { WorkspaceId } from "@money-maker/contracts";
import { LOCAL_GENERATOR_LICENSES, LOCAL_MODEL_LICENSES } from "./model-policy.js";

export { LOCAL_GENERATOR_LICENSES, LOCAL_MODEL_LICENSES } from "./model-policy.js";

export type AssetProvenance =
  | "operator_upload"
  | "generated"
  | "provider_import"
  | "stock"
  | "rendered";
/**
 * pending: upload not finished. pending_review: stored and sanitized but held for a human
 * decision (home worker images, ADR 0012); never picked, listed as usable, or rendered.
 */
export type AssetState = "pending" | "active" | "archived" | "pending_review";

export type Asset = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  objectKey: string;
  checksum: string;
  byteSize?: number;
  durationMs?: number;
  commercialUse: boolean | null;
  sourceUrl?: string;
  creator?: string;
  mimeType: string;
  width: number;
  height: number;
  provenance: AssetProvenance;
  license: string;
  metadata?: Readonly<Record<string, unknown>>;
  state: AssetState;
}>;

export type CreateAssetInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  mimeType: string;
  checksum: string;
  byteSize?: number;
  durationMs?: number;
  commercialUse?: boolean | null;
  sourceUrl?: string;
  creator?: string;
  width: number;
  height: number;
  provenance: AssetProvenance;
  license: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CreateAssetResult =
  | Readonly<{ ok: true; asset: Asset }>
  | Readonly<{
      ok: false;
      code: "unsupported_media_type" | "invalid_dimensions" | "invalid_metadata";
    }>;

/**
 * Local generators whose weights licence is verified for commercial output (spec section 4:
 * unknown licence is not an approved licence). LTX-2.x is absent on purpose: its community
 * licence is revenue-capped and needs an owner decision.
 */

/** Models that must not run on a machine kind (v2 spec 17.3): Bonsai Image is the M1's model. */
const MODEL_REFUSED_ON: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "local:bonsai-image-4b": ["desktop_amd"],
});
export const modelRefusedOnMachine = (model: string, machineKind: string | undefined): boolean =>
  machineKind !== undefined && (MODEL_REFUSED_ON[model] ?? []).includes(machineKind);

/**
 * Local non-image models a local_ai worker may serve (v2 spec 25): director, VLM, upscaler,
 * segmenter and TTS weights whose licence is verified. A model absent here cannot be configured
 * (verify-models rejects it); image generators are checked against LOCAL_GENERATOR_LICENSES.
 */
export const isAllowedLocalModel = (id: string): boolean =>
  Object.hasOwn(LOCAL_MODEL_LICENSES, id) || Object.hasOwn(LOCAL_GENERATOR_LICENSES, id);
/**
 * G0 allowlist of generated scene-clip models (`agnes:<model>`) whose terms the owner verified for
 * commercial use. Empty today: the gate trusts this list, never an asset commercialUse flag.
 */
export const VERIFIED_CLIP_MODELS: ReadonlySet<string> = new Set<string>([
  "agnes:agnes-video-v2.0",
]);

export const COMMERCIAL_USE_BY_PROVIDER: ReadonlySet<string> = new Set([
  "@cf/black-forest-labs/flux-1-schnell",
  "money-maker:procedural-scene-v1",
  // Deterministic SceneSpec stills: original vector art drawn by our own code.
  "money-maker:stickman-still-v1",
  ...Object.keys(LOCAL_GENERATOR_LICENSES),
]);

const supportedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4"]);

export const createAsset = (input: CreateAssetInput): CreateAssetResult => {
  if (!supportedMimeTypes.has(input.mimeType)) return { ok: false, code: "unsupported_media_type" };
  if (
    !Number.isInteger(input.width) ||
    !Number.isInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return { ok: false, code: "invalid_dimensions" };
  }
  if (input.checksum.trim().length === 0 || input.license.trim().length === 0) {
    return { ok: false, code: "invalid_metadata" };
  }
  if (
    input.provenance === "generated" &&
    input.commercialUse === true &&
    !COMMERCIAL_USE_BY_PROVIDER.has(input.creator ?? "")
  )
    return { ok: false, code: "invalid_metadata" };
  if (
    input.provenance === "operator_upload" &&
    input.commercialUse === true &&
    !/^(owned|licensed:.+)$/i.test(input.license.trim())
  )
    return { ok: false, code: "invalid_metadata" };
  if (
    input.provenance === "stock" &&
    (!input.sourceUrl ||
      !input.creator ||
      input.commercialUse === undefined ||
      input.commercialUse === null)
  )
    return { ok: false, code: "invalid_metadata" };
  if (
    input.byteSize !== undefined &&
    (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0)
  )
    return { ok: false, code: "invalid_metadata" };
  if (
    input.durationMs !== undefined &&
    (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0)
  )
    return { ok: false, code: "invalid_metadata" };
  const id = input.id ?? crypto.randomUUID();
  return {
    ok: true,
    asset: Object.freeze({
      id,
      workspaceId: input.workspaceId,
      objectKey: `workspaces/${input.workspaceId}/assets/${id}`,
      checksum: input.checksum.trim(),
      ...(input.byteSize !== undefined ? { byteSize: input.byteSize } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
      commercialUse: input.commercialUse ?? null,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
      ...(input.creator ? { creator: input.creator } : {}),
      mimeType: input.mimeType,
      width: input.width,
      height: input.height,
      provenance: input.provenance,
      license: input.license.trim(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      state: "pending" as const,
    }),
  };
};
