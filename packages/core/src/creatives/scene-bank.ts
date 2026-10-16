import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { type Asset, COMMERCIAL_USE_BY_PROVIDER, createAsset } from "../assets/asset.js";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { AssetStore } from "../assets/asset-store.js";
import type { BudgetDecision } from "../usage/generation-budget.js";
import { utcDayStart } from "../usage/generation-budget.js";
import type { UsageRepository } from "../usage/usage-repository.js";
import { SCENE_PROMPT_VERSION, type ScenePlan, sceneKey, scenePrompt } from "./scene-plan.js";

export type GeneratedSceneImage = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  neurons: number;
  model?: string;
  license?: string;
  seed?: number;
  provenance?: Readonly<{ runtime: string; observedModel?: string; runtimeVersion?: string }>;
  postProcess?: Readonly<Record<string, unknown>>;
  review?: Readonly<Record<string, unknown>>;
}>;
export type SceneGenerator = {
  generate(
    prompt: string,
    /** Wanted size; a generator that cannot choose (Workers AI) returns its own and the frame covers. */
    size?: Readonly<{ width: number; height: number }>,
    /** Style reference image for generators that can edit from one (local command only). */
    /** `seed` pins the sampler seed for generators that accept one (benchmarks); others ignore it. */
    options?: Readonly<{ reference?: Uint8Array; seed?: number }>,
  ): Promise<GeneratedSceneImage>;
};
/** Editing is a distinct operation. Inputs are decoded bytes from a workspace-scoped asset. */
export type ImageEditor = Readonly<{
  edit(
    prompt: string,
    /** One image, or 1..4 references in prompt order ("first reference image", ...). */
    referenceImage: Uint8Array | readonly Uint8Array[],
    size?: Readonly<{ width: number; height: number }>,
    /** A pinned seed (auto-package scenes are deterministic per slide and attempt). */
    options?: Readonly<{ seed?: number }>,
  ): Promise<GeneratedSceneImage>;
}>;
export type SceneBankDeps = Readonly<{
  assets: Pick<AssetRepository, "create" | "updateState"> & {
    listByMetadata: NonNullable<AssetRepository["listByMetadata"]>;
    updateMetadata: NonNullable<AssetRepository["updateMetadata"]>;
  };
  store: Pick<AssetStore, "putObject">;
  generator: SceneGenerator | null;
  usage: UsageRepository;
  budget: (usedToday: number) => BudgetDecision;
  now: () => Date;
  onFallback?: (reason: string) => void;
}>;
export const SCENE_POOL_MIN = 8;
export const SCENE_MAX_AGE_DAYS = 60;
export type PickedScene = Readonly<
  { assetId: string; source: "bank" | "generated" } | { procedural: true }
>;
const SCENE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const SCENE_LICENSE = "FLUX.1 schnell (Apache-2.0) via Cloudflare Workers AI";

/** One bank of reusable generated images: which assets it holds, how to make one, how many to keep. */
export type SceneBankRequest = Readonly<{
  /** Asset metadata role of the bank (scene, explainer_background). */
  role: string;
  /** Metadata sceneKey shared by the bank's assets. */
  key: string;
  prompt: string;
  poolMin: number;
  size?: Readonly<{ width: number; height: number }>;
  /** Extra metadata stored on generated assets (plan, setting, prompt version...). */
  metadata: Readonly<Record<string, unknown>>;
}>;

export const sceneBankRequest = (nicheId: string, plan: ScenePlan): SceneBankRequest => ({
  role: "scene",
  key: sceneKey(nicheId, plan),
  prompt: scenePrompt(plan),
  poolMin: SCENE_POOL_MIN,
  metadata: { plan, promptVersion: SCENE_PROMPT_VERSION },
});

const activeScenes = (pool: readonly Asset[], now: Date): Asset[] => {
  const minTime = now.getTime() - SCENE_MAX_AGE_DAYS * 86_400_000;
  return pool.filter((asset) => {
    const createdAt = asset.metadata?.createdAt;
    return typeof createdAt !== "string" || new Date(createdAt).getTime() >= minTime;
  });
};

/** Least-used asset outside the recent set, or of the whole pool when every asset is recent. */
export const leastUsed = (
  pool: readonly Asset[],
  recentIds: readonly string[],
): Asset | undefined => {
  const candidates = pool.filter((asset) => !recentIds.includes(asset.id));
  const available = [...(candidates.length > 0 ? candidates : pool)];
  available.sort((a, b) => {
    const usesA = Number(a.metadata?.usageCount ?? 0);
    const usesB = Number(b.metadata?.usageCount ?? 0);
    if (usesA !== usesB) return usesA - usesB;
    return String(a.metadata?.lastUsedAt ?? "").localeCompare(String(b.metadata?.lastUsedAt ?? ""));
  });
  return available[0];
};

export const pickBankedImage = async (
  deps: SceneBankDeps,
  input: {
    workspaceId: WorkspaceId;
    request: SceneBankRequest;
    recentSceneIds: readonly string[];
    correlationId?: string;
  },
): Promise<PickedScene> => {
  const { request } = input;
  const generatedSceneIds = new Set<string>();
  let pool = activeScenes(
    await deps.assets.listByMetadata({
      workspaceId: input.workspaceId,
      role: request.role,
      key: "sceneKey",
      value: request.key,
    }),
    deps.now(),
  );
  const dayStart = utcDayStart(deps.now());
  const usedToday = await deps.usage.sum({
    workspaceId: input.workspaceId,
    provider: "cloudflare_workers_ai",
    unit: "neurons",
    since: dayStart,
  });
  const decision = deps.budget(usedToday);
  if (pool.length < request.poolMin && decision === "generate" && deps.generator) {
    try {
      const generated = request.size
        ? await deps.generator.generate(request.prompt, request.size)
        : await deps.generator.generate(request.prompt);
      // ponytail: local generators record 0 neurons under the Workers AI provider row; split the
      // usage provider if local generation ever needs its own budget.
      await deps.usage.record({
        workspaceId: input.workspaceId,
        provider: "cloudflare_workers_ai",
        unit: "neurons",
        quantity: generated.neurons,
        operation: "scene_generate",
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      });
      const id = randomUUID();
      const checksum = createHash("sha256").update(generated.bytes).digest("hex");
      const model = generated.model ?? SCENE_MODEL;
      const created = createAsset({
        id,
        workspaceId: input.workspaceId,
        mimeType: generated.mimeType,
        checksum,
        width: generated.width,
        height: generated.height,
        provenance: "generated",
        license: generated.license ?? SCENE_LICENSE,
        // Only generators with a verified licence carry commercial rights.
        commercialUse: !generated.review && COMMERCIAL_USE_BY_PROVIDER.has(model) ? true : null,
        creator: model,
        metadata: {
          role: request.role,
          sceneKey: request.key,
          ...request.metadata,
          prompt: request.prompt,
          ...(generated.seed !== undefined ? { seed: generated.seed } : {}),
          ...(generated.postProcess ? { postProcess: generated.postProcess } : {}),
          ...(generated.review ? { homeWorker: generated.review } : {}),
          model,
          usageCount: 0,
          lastUsedAt: null,
          createdAt: deps.now().toISOString(),
          fingerprint: checksum.slice(0, 16),
        },
      });
      if (!created.ok) throw new Error("scene_asset_invalid");
      await deps.assets.create(created.asset);
      try {
        await deps.store.putObject({
          workspaceId: input.workspaceId,
          assetId: id,
          mimeType: generated.mimeType,
          checksum,
          width: generated.width,
          height: generated.height,
          bytes: generated.bytes,
        });
      } catch (error) {
        await deps.assets.updateState({
          workspaceId: input.workspaceId,
          assetId: id,
          state: "archived",
        });
        throw error;
      }
      const active = await deps.assets.updateState({
        workspaceId: input.workspaceId,
        assetId: id,
        state: generated.review ? "pending_review" : "active",
      });
      if (!active) throw new Error("scene_asset_activation_failed");
      if (!generated.review) {
        generatedSceneIds.add(id);
        pool = [
          ...pool,
          { ...active, metadata: { ...active.metadata, usageCount: 0, lastUsedAt: null } },
        ];
      }
    } catch (error) {
      deps.onFallback?.(error instanceof Error ? error.message : "scene_provider_error");
    }
  }
  if (decision === "procedural_only") {
    deps.onFallback?.("scene_budget_procedural_only");
    return { procedural: true };
  }
  const selected = leastUsed(pool, input.recentSceneIds);
  if (!selected) {
    deps.onFallback?.("scene_bank_empty");
    return { procedural: true };
  }
  await deps.assets.updateMetadata({
    workspaceId: input.workspaceId,
    assetId: selected.id,
    patch: {
      usageCount: Number(selected.metadata?.usageCount ?? 0) + 1,
      lastUsedAt: deps.now().toISOString(),
    },
  });
  return {
    assetId: selected.id,
    source: generatedSceneIds.has(selected.id) ? "generated" : "bank",
  };
};

export const pickScene = (
  deps: SceneBankDeps,
  input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    plan: ScenePlan;
    recentSceneIds: readonly string[];
    correlationId?: string;
  },
): Promise<PickedScene> =>
  pickBankedImage(deps, {
    workspaceId: input.workspaceId,
    request: sceneBankRequest(input.nicheId, input.plan),
    recentSceneIds: input.recentSceneIds,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
  });
