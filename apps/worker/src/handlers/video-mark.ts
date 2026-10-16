import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { ReelMarkInput } from "@money-maker/core/assets/reel-renderer";
import type { VideoMarkPlan } from "@money-maker/core/brand/video-mark";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";

const maxLogoBytes = 5_000_000;

/**
 * Loads the niche's logo variants for the video mark. Only active assets cleared for commercial
 * use are used; any failure drops that logo, never the render.
 */
export const loadVideoMark = async (input: {
  plan: VideoMarkPlan | undefined;
  workspaceId: Parameters<AssetRepository["findForWorkspace"]>[0]["workspaceId"];
  assets: Pick<AssetRepository, "findForWorkspace">;
  store: Pick<AssetStore, "createDownload">;
}): Promise<ReelMarkInput | undefined> => {
  const { plan } = input;
  if (!plan) return undefined;
  const load = async (assetId: string | undefined): Promise<Uint8Array | undefined> => {
    if (!assetId) return undefined;
    try {
      const asset = await input.assets.findForWorkspace({
        workspaceId: input.workspaceId,
        assetId,
      });
      if (asset?.state !== "active" || asset.commercialUse !== true) return undefined;
      const download = await input.store.createDownload({
        workspaceId: input.workspaceId,
        assetId: asset.id,
      });
      const media = await fetchSafeMedia(new URL(download.url), {
        maxBytes: maxLogoBytes,
        allowedMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      });
      return media.bytes;
    } catch {
      return undefined;
    }
  };
  const [logoLight, logoDark] = await Promise.all([
    load(plan.logoLightAssetId),
    load(plan.logoDarkAssetId),
  ]);
  if (!logoLight && !logoDark) return undefined;
  return {
    opacity: plan.opacity,
    position: plan.position,
    minWidth: plan.minWidth,
    safeMargin: plan.safeMargin,
    ...(logoLight ? { logoLight } : {}),
    ...(logoDark ? { logoDark } : {}),
  };
};
