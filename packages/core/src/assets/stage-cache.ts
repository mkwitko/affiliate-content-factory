import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { canonicalJson } from "../shared/canonical-json.js";
import type { Asset } from "./asset.js";
import type { AssetRepository } from "./asset-repository.js";
import type { AssetStore } from "./asset-store.js";

/**
 * Cross-attempt cache for expensive render stages (spec 2026-09-30-stage-artifact-cache).
 * An entry is an ordinary Asset with role `stage_artifact`; the key is a sha256 of the canonical
 * stage inputs plus a caller-supplied version, so a model upgrade misses by construction.
 * Cache assets are infrastructure: repositories exclude this role from operator lists.
 */
export const STAGE_ARTIFACT_ROLE = "stage_artifact";

export type StageArtifact = Readonly<{
  bytes: Uint8Array;
  mimeType: string;
  /** Producer-defined, JSON-safe; returned verbatim on a hit (for TTS: durationMs, words). */
  metadata: Readonly<Record<string, unknown>>;
}>;

export type StageCacheResult = StageArtifact & Readonly<{ hit: boolean; assetId: string }>;

export type StageCacheRequest = Readonly<{
  workspaceId: WorkspaceId;
  stage: string;
  version: string;
  inputs: unknown;
  produce: () => Promise<StageArtifact>;
}>;

export interface StageCache {
  getOrProduce(input: StageCacheRequest): Promise<StageCacheResult>;
}

export type StageCacheDependencies = Readonly<{
  assets: Pick<AssetRepository, "create" | "updateState"> &
    Required<Pick<AssetRepository, "listByMetadata" | "updateMetadata">>;
  store: Pick<AssetStore, "putObject" | "createDownload">;
  /** Downloads a signed URL; the worker passes fetchSafeMedia with an audio allowlist. */
  fetchBytes: (url: string) => Promise<Uint8Array>;
  now?: () => Date;
  /** Structured events; never receives stage inputs (narration text stays out of logs). */
  log?: (event: Readonly<Record<string, unknown>>) => void;
}>;

export const stageCacheKey = (input: { stage: string; version: string; inputs: unknown }): string =>
  createHash("sha256")
    .update(
      canonicalJson({ stage: input.stage, version: input.version, inputs: input.inputs }),
      "utf8",
    )
    .digest("hex");

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const INTERNAL_KEYS = new Set(["role", "stage", "cacheKey", "version", "usageCount", "lastUsedAt"]);
const producerMetadata = (asset: Asset): Readonly<Record<string, unknown>> =>
  Object.fromEntries(
    Object.entries(asset.metadata ?? {}).filter(([key]) => !INTERNAL_KEYS.has(key)),
  );

export const createStageCache = (deps: StageCacheDependencies): StageCache => {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const tryHit = async (
    input: StageCacheRequest,
    key: string,
  ): Promise<StageCacheResult | null> => {
    let candidates: readonly Asset[];
    try {
      candidates = await deps.assets.listByMetadata({
        workspaceId: input.workspaceId,
        role: STAGE_ARTIFACT_ROLE,
        key: "cacheKey",
        value: key,
      });
    } catch {
      // The cache is an optimisation: a failing lookup degrades to an uncached stage.
      log({ event: "stage_cache_lookup_failed", stage: input.stage, key: key.slice(0, 12) });
      return null;
    }
    const asset = candidates[0];
    if (!asset) return null;
    let bytes: Uint8Array;
    try {
      const download = await deps.store.createDownload({
        workspaceId: input.workspaceId,
        assetId: asset.id,
      });
      bytes = await deps.fetchBytes(download.url);
    } catch {
      log({ event: "stage_cache_download_failed", stage: input.stage, key: key.slice(0, 12) });
      return null;
    }
    if (sha256(bytes) !== asset.checksum) {
      log({ event: "stage_cache_checksum_mismatch", stage: input.stage, key: key.slice(0, 12) });
      return null;
    }
    const count = asset.metadata?.["usageCount"];
    try {
      await deps.assets.updateMetadata({
        workspaceId: input.workspaceId,
        assetId: asset.id,
        patch: {
          usageCount: (typeof count === "number" ? count : 0) + 1,
          lastUsedAt: now().toISOString(),
        },
      });
    } catch {
      // Usage counters are best effort; a ledger failure never fails a render.
    }
    return {
      hit: true,
      assetId: asset.id,
      bytes,
      mimeType: asset.mimeType,
      metadata: producerMetadata(asset),
    };
  };

  return {
    async getOrProduce(input) {
      const key = stageCacheKey(input);
      const hit = await tryHit(input, key);
      log({
        event: "stage_cache",
        stage: input.stage,
        hit: hit !== null,
        key: key.slice(0, 12),
        workspaceId: input.workspaceId,
      });
      if (hit) return hit;

      const produced = await input.produce();
      const id = randomUUID();
      const checksum = sha256(produced.bytes);
      // Built directly, not through createAsset: audio is not an operator-facing media type and
      // has no pixel dimensions. Width/height 0 mark "not an image".
      const asset: Asset = {
        id,
        workspaceId: input.workspaceId,
        objectKey: `workspaces/${input.workspaceId}/assets/${id}`,
        checksum,
        byteSize: produced.bytes.byteLength,
        commercialUse: null,
        mimeType: produced.mimeType,
        width: 0,
        height: 0,
        provenance: "generated",
        license: "internal",
        metadata: {
          ...produced.metadata,
          role: STAGE_ARTIFACT_ROLE,
          stage: input.stage,
          cacheKey: key,
          version: input.version,
          usageCount: 1,
          lastUsedAt: now().toISOString(),
        },
        state: "pending",
      };
      try {
        await deps.assets.create(asset);
        await deps.store.putObject({
          workspaceId: input.workspaceId,
          assetId: id,
          mimeType: produced.mimeType,
          checksum,
          width: 0,
          height: 0,
          bytes: produced.bytes,
        });
        await deps.assets.updateState({
          workspaceId: input.workspaceId,
          assetId: id,
          state: "active",
        });
      } catch {
        // Storing is best effort: the stage already succeeded, so the render keeps its output.
        // ponytail: a failed putObject/updateState leaves a PENDING row that lookups ignore;
        // add a sweep if they accumulate.
        log({ event: "stage_cache_store_failed", stage: input.stage, key: key.slice(0, 12) });
      }
      // ponytail: no lock on miss; two workers may both produce the same key and the newest wins
      // on the next lookup. Add an advisory lock if duplicate produces show in metrics.
      return { hit: false, assetId: id, ...produced };
    },
  };
};
