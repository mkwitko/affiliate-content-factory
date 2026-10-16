import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvironment } from "@money-maker/config";
import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { COMMERCIAL_USE_BY_PROVIDER, createAsset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  AMBIENT_LOOP_LIMITS,
  AMBIENT_LOOP_ROLE,
  type AmbientLoopMeasure,
  ambientLoopVerdict,
  EXPLAINER_ART_STYLES,
  EXPLAINER_BACKGROUND_ROLE,
  type ExplainerArtStyle,
  explainerBackgroundKey,
  type GenerationProvenance,
  LOCATION_PLATE_TEMPLATE_VERSION,
  locationPlateKey,
  readGenerationProvenance,
} from "@money-maker/core/explainer/background-art";
import { BACKGROUNDS, type BackgroundId } from "@money-maker/core/explainer/backgrounds";
import { platePostProcessPlan } from "@money-maker/core/explainer/compositing";
import {
  readExplainerContext,
  scenePaletteFor,
} from "@money-maker/core/explainer/explainer-context";
import { PrismaAssetRepository } from "@money-maker/providers/database/asset-repository";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";
import { fitImage } from "@money-maker/providers/http/fit-image";
import { measureAmbientLoop } from "@money-maker/providers/media/ambient-loop";
import { postProcessPlate } from "@money-maker/providers/media/plate-postprocess";
import { R2AssetStore } from "@money-maker/providers/storage/r2-asset-store";
import { createR2S3SigningClient } from "@money-maker/providers/storage/r2-s3-signing-client";

type ManifestItem =
  | Readonly<{
      kind: "background";
      file: string;
      setting: BackgroundId;
      style: ExplainerArtStyle;
      /** A location plate (v2 slice 24): banked under the location key instead of the setting. */
      location?: string | undefined;
      generation: GenerationProvenance;
    }>
  | Readonly<{
      kind: "ambient_loop";
      file: string;
      background: string;
      generation: GenerationProvenance;
    }>;
export type LocalMediaManifest = Readonly<{
  version: 1;
  nicheId: string;
  items: readonly ManifestItem[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** A bare file name inside the folder: no separators, so no path escapes it. */
const isFileName = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value);

/** Untrusted JSON from the owner's folder: every item must be complete or the manifest is refused. */
export const parseLocalMediaManifest = (value: unknown): LocalMediaManifest | null => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.nicheId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.nicheId) ||
    !Array.isArray(value.items)
  )
    return null;
  const items: ManifestItem[] = [];
  for (const entry of value.items) {
    if (!isRecord(entry) || !isFileName(entry.file)) return null;
    const generation = readGenerationProvenance(entry.generation);
    if (!generation) return null;
    if (
      entry.kind === "background" &&
      (BACKGROUNDS as readonly unknown[]).includes(entry.setting) &&
      (EXPLAINER_ART_STYLES as readonly unknown[]).includes(entry.style)
    )
      items.push({
        kind: "background",
        file: entry.file,
        setting: entry.setting as BackgroundId,
        style: entry.style as ExplainerArtStyle,
        ...(typeof entry.location === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(entry.location)
          ? { location: entry.location }
          : {}),
        generation,
      });
    else if (entry.kind === "ambient_loop" && isFileName(entry.background))
      items.push({
        kind: "ambient_loop",
        file: entry.file,
        background: entry.background,
        generation,
      });
    else return null;
  }
  return { version: 1, nicheId: value.nicheId, items };
};

export type ImportLocalMediaDeps = Readonly<{
  assets: Pick<AssetRepository, "create" | "updateState" | "findByMetadata">;
  store: Pick<AssetStore, "putObject">;
  readFile: (path: string) => Promise<Uint8Array>;
  probeImage: (
    bytes: Uint8Array,
  ) => Promise<Readonly<{ mimeType: string; width: number; height: number }>>;
  measureLoop: (
    bytes: Uint8Array,
  ) => Promise<AmbientLoopMeasure & Readonly<{ width: number; height: number }>>;
  /**
   * The niche's compositing post-process (v2 slice 14) for backgrounds; absent stores the bytes
   * as generated. The fingerprint stays that of the source file, so re-runs still skip it.
   */
  postProcess?:
    | ((bytes: Uint8Array) => Promise<
        Readonly<{
          bytes: Uint8Array;
          mimeType: "image/jpeg";
          record: Readonly<Record<string, unknown>>;
        }>
      >)
    | undefined;
  now: () => Date;
}>;
type ImportResult = Readonly<{
  imported: readonly Readonly<{ file: string; assetId: string }>[];
  skipped: readonly Readonly<{ file: string; reason: string }>[];
}>;
const MIN_BACKGROUND_PX = 512;
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Imports an owner-generated folder: backgrounds join the niche's explainer bank, loops attach to
 * a background of the same manifest after seam and freeze QA. Rights come only from the model
 * allowlist (COMMERCIAL_USE_BY_PROVIDER); anything else imports with commercialUse null and is
 * never rendered. Re-running skips files already imported (by fingerprint).
 */
export const importLocalMedia = async (
  deps: ImportLocalMediaDeps,
  input: Readonly<{ workspaceId: WorkspaceId; folder: string; manifest: LocalMediaManifest }>,
): Promise<ImportResult> => {
  const { workspaceId, manifest } = input;
  const imported: { file: string; assetId: string }[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const backgroundIds = new Map<string, string>();
  const ordered = [...manifest.items].sort(
    (a, b) => Number(a.kind !== "background") - Number(b.kind !== "background"),
  );
  for (const item of ordered) {
    const skip = (reason: string) => void skipped.push({ file: item.file, reason });
    const bytes = await deps.readFile(join(input.folder, item.file)).catch(() => null);
    if (!bytes) {
      skip("file_missing");
      continue;
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const fingerprint = checksum.slice(0, 16);
    const role = item.kind === "background" ? EXPLAINER_BACKGROUND_ROLE : AMBIENT_LOOP_ROLE;
    const existing = await deps.assets.findByMetadata({
      workspaceId,
      role,
      key: "fingerprint",
      value: fingerprint,
    });
    if (existing) {
      if (item.kind === "background") backgroundIds.set(item.file, existing.id);
      skip("already_imported");
      continue;
    }
    const base = {
      workspaceId,
      checksum,
      byteSize: bytes.byteLength,
      provenance: "generated" as const,
      creator: item.generation.model,
      license: `${item.generation.weightsLicense} (${item.generation.model}, local)`,
      commercialUse: COMMERCIAL_USE_BY_PROVIDER.has(item.generation.model) ? true : null,
    };
    const common = {
      generation: item.generation,
      createdAt: deps.now().toISOString(),
      fingerprint,
    };
    let created: ReturnType<typeof createAsset>;
    let stored = bytes;
    let storedChecksum = checksum;
    if (item.kind === "background") {
      const image = await deps.probeImage(bytes).catch(() => null);
      if (!image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg")) {
        skip("image_unreadable");
        continue;
      }
      if (image.width < MIN_BACKGROUND_PX || image.height < MIN_BACKGROUND_PX) {
        skip("image_too_small");
        continue;
      }
      const processed = deps.postProcess ? await deps.postProcess(bytes) : null;
      if (processed) {
        stored = processed.bytes;
        storedChecksum = createHash("sha256").update(stored).digest("hex");
      }
      created = createAsset({
        ...base,
        checksum: storedChecksum,
        byteSize: stored.byteLength,
        mimeType: processed?.mimeType ?? image.mimeType,
        width: image.width,
        height: image.height,
        metadata: {
          role,
          nicheId: manifest.nicheId,
          sceneKey: item.location
            ? locationPlateKey(manifest.nicheId, { locationId: item.location, style: item.style })
            : explainerBackgroundKey(manifest.nicheId, item),
          ...(item.location
            ? { locationId: item.location, promptTemplateVersion: LOCATION_PLATE_TEMPLATE_VERSION }
            : {}),
          setting: item.setting,
          style: item.style,
          usageCount: 0,
          lastUsedAt: null,
          ...(processed ? { postProcess: processed.record } : {}),
          ...common,
        },
      });
    } else {
      const backgroundAssetId = backgroundIds.get(item.background);
      if (!backgroundAssetId) {
        skip("background_missing");
        continue;
      }
      if (bytes.byteLength > AMBIENT_LOOP_LIMITS.maxBytes) {
        skip("loop_too_large");
        continue;
      }
      const measure = await deps.measureLoop(bytes).catch(() => null);
      if (!measure) {
        skip("loop_unreadable");
        continue;
      }
      const qa = ambientLoopVerdict(measure);
      if (qa.verdict === "block") {
        skip(qa.reason);
        continue;
      }
      created = createAsset({
        ...base,
        mimeType: "video/mp4",
        width: measure.width,
        height: measure.height,
        durationMs: measure.durationMs,
        metadata: {
          role,
          nicheId: manifest.nicheId,
          backgroundAssetId,
          qa: { verdict: qa.verdict, motion: round2(measure.motion), seam: round2(measure.seam) },
          ...common,
        },
      });
    }
    if (!created.ok) {
      skip(`asset_invalid:${created.code}`);
      continue;
    }
    const { asset } = created;
    await deps.store.putObject({
      workspaceId,
      assetId: asset.id,
      mimeType: asset.mimeType,
      checksum: storedChecksum,
      width: asset.width,
      height: asset.height,
      bytes: stored,
    });
    await deps.assets.create(asset);
    await deps.assets.updateState({ workspaceId, assetId: asset.id, state: "active" });
    if (item.kind === "background") backgroundIds.set(item.file, asset.id);
    imported.push({ file: item.file, assetId: asset.id });
  }
  return { imported, skipped };
};

const main = async (): Promise<void> => {
  const [workspaceArg, folder] = process.argv.slice(2);
  let client: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    if (!workspaceArg || !folder)
      throw new Error("Usage: node dist/commands/import-local-media.js <workspaceId> <folder>");
    const environment = parseEnvironment(process.env);
    if (
      !environment.R2_ACCOUNT_ID ||
      !environment.R2_ACCESS_KEY_ID ||
      !environment.R2_SECRET_ACCESS_KEY ||
      !environment.R2_BUCKET
    )
      throw new Error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
    const manifest = parseLocalMediaManifest(
      JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
    );
    if (!manifest) throw new Error("manifest.json is invalid (see scripts/local-ai/README.md).");
    client = createDatabaseClient(environment.DATABASE_URL);
    const workspaceId = parseWorkspaceId(workspaceArg);
    const niche = await new PrismaNicheRepository(client).findForWorkspace({
      workspaceId,
      nicheId: manifest.nicheId,
    });
    const profile = niche ? readExplainerContext(niche)?.compositing : undefined;
    const plan = niche && profile ? platePostProcessPlan(profile, scenePaletteFor(niche)) : null;
    const result = await importLocalMedia(
      {
        assets: new PrismaAssetRepository(client),
        store: new R2AssetStore(
          createR2S3SigningClient({
            accountId: environment.R2_ACCOUNT_ID,
            accessKeyId: environment.R2_ACCESS_KEY_ID,
            secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
            bucketName: environment.R2_BUCKET,
          }),
          environment.R2_BUCKET,
          environment.R2_SIGNED_URL_TTL ?? 900,
        ),
        readFile: async (path) => new Uint8Array(await readFile(path)),
        probeImage: (bytes) => fitImage(bytes),
        measureLoop: (bytes) => measureAmbientLoop(bytes),
        ...(plan ? { postProcess: (bytes: Uint8Array) => postProcessPlate(bytes, plan) } : {}),
        now: () => new Date(),
      },
      { workspaceId, folder, manifest },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client?.$disconnect();
  }
};

if (process.argv[1]?.endsWith("import-local-media.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Local media import failed.");
    process.exitCode = 1;
  });
}
