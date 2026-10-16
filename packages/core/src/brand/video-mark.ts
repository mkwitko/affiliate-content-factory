import type { BrandKit, BrandKitOverride } from "./brand-kit.js";
import { mergeBrandKit } from "./brand-kit.js";

export type MarkPosition = BrandKit["mark"]["position"];

/** Niche context `videoMark`: off unless `enabled` is true. */
export type VideoMarkPlan = Readonly<{
  opacity: number;
  position: MarkPosition;
  minWidth: number;
  safeMargin: number;
  logoLightAssetId?: string;
  logoDarkAssetId?: string;
}>;

const POSITIONS: readonly MarkPosition[] = ["top-left", "top-right", "bottom-left"];
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** The mark to overlay on a niche's videos, or undefined when disabled or no logo is set. */
export const readVideoMarkPlan = (
  niche: Readonly<{ context?: Readonly<Record<string, unknown>> | null }> | null | undefined,
  channel?: Readonly<{ context?: Readonly<Record<string, unknown>> | null }> | null,
): VideoMarkPlan | undefined => {
  const config = record(niche?.context?.["videoMark"]);
  if (config?.["enabled"] !== true) return undefined;
  let brand: BrandKit;
  try {
    brand = mergeBrandKit(
      record(niche?.context?.["brandKit"]) as BrandKitOverride | undefined,
      record(channel?.context?.["brandKit"]) as BrandKitOverride | undefined,
    );
  } catch {
    return undefined; // invalid brand colours: no mark rather than a failed render
  }
  if (!brand.logoLightAssetId && !brand.logoDarkAssetId) return undefined;
  const opacity = config["opacity"];
  const position = config["position"];
  return {
    opacity: typeof opacity === "number" && opacity >= 0.4 && opacity <= 0.9 ? opacity : 0.7,
    position: POSITIONS.includes(position as MarkPosition)
      ? (position as MarkPosition)
      : brand.mark.position,
    minWidth: brand.mark.minWidth,
    safeMargin: brand.mark.safeMargin,
    ...(brand.logoLightAssetId ? { logoLightAssetId: brand.logoLightAssetId } : {}),
    ...(brand.logoDarkAssetId ? { logoDarkAssetId: brand.logoDarkAssetId } : {}),
  };
};
