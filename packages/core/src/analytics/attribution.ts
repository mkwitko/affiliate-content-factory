import { createHash, randomBytes } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
export type TrackingSlug = string & { readonly __trackingSlug: unique symbol };
export type RedirectRecord = Readonly<{
  slug: TrackingSlug;
  workspaceId: WorkspaceId;
  destination: string;
  destinationFingerprint: string;
  expiresAt: Date;
  contentVariantId?: string;
  publicationAttemptId?: string;
  offerId?: string;
  /** Existing Mercado Livre label associated with this affiliate destination. */
  marketplaceLabel?: string;
  /** Where an expired or altered link goes instead (the plain listing), so a live post never dead-ends. */
  fallbackUrl?: string;
}>;
/** How a click reached the offer. */
export type ClickVia = "direct" | "bio_latest" | "storefront";
export type ClickEvent = Readonly<{
  workspaceId: WorkspaceId;
  slug?: TrackingSlug;
  contentVariantId?: string;
  publicationAttemptId?: string;
  via: ClickVia;
  expired: boolean;
  visitorHash: string;
  referrerHost?: string;
}>;
export type AttributionGroupBy = "publication" | "variant" | "contentItem" | "niche" | "channel";
export type AttributionRow = Readonly<{
  key: string;
  clicks: number;
  uniqueClicks: number;
  lastClickAt: Date;
}>;
/** Link lifetime: feed posts stay up for months. */
export const TRACKED_LINK_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const isValidMercadoLivreLabel = (value: string): boolean =>
  /^[a-z0-9_-]{1,30}$/.test(value);
const fingerprint = (url: string) => createHash("sha256").update(url).digest("hex");
export const destinationFingerprint = fingerprint;
export const createRedirect = (input: {
  workspaceId: WorkspaceId;
  destination: URL;
  expiresAt: Date;
  contentVariantId?: string;
  publicationAttemptId?: string;
  offerId?: string;
  fallback?: URL;
  marketplaceLabel?: string;
}): RedirectRecord => {
  for (const url of [input.destination, input.fallback]) {
    if (url && (url.protocol !== "https:" || url.username || url.password))
      throw new Error("destination_not_allowed");
  }
  if (input.marketplaceLabel !== undefined && !isValidMercadoLivreLabel(input.marketplaceLabel))
    throw new Error("invalid_marketplace_label");
  return {
    slug: randomBytes(12).toString("base64url") as TrackingSlug,
    workspaceId: input.workspaceId,
    destination: input.destination.toString(),
    destinationFingerprint: fingerprint(input.destination.toString()),
    expiresAt: input.expiresAt,
    ...(input.contentVariantId ? { contentVariantId: input.contentVariantId } : {}),
    ...(input.publicationAttemptId ? { publicationAttemptId: input.publicationAttemptId } : {}),
    ...(input.offerId ? { offerId: input.offerId } : {}),
    ...(input.marketplaceLabel ? { marketplaceLabel: input.marketplaceLabel } : {}),
    ...(input.fallback ? { fallbackUrl: input.fallback.toString() } : {}),
  };
};
export const resolveTrackedRedirect = (
  record: RedirectRecord,
  now = new Date(),
): { url: URL; expired: boolean } => {
  const destination = new URL(record.destination);
  if (
    record.expiresAt > now &&
    fingerprint(destination.toString()) === record.destinationFingerprint
  )
    return { url: destination, expired: false };
  if (!record.fallbackUrl) throw new Error("tracking_expired");
  return { url: new URL(record.fallbackUrl), expired: true };
};
/** Salted, daily-rotating visitor hash: counts unique clicks per day, cannot follow a visitor across days. */
export const visitorHash = (input: {
  salt: string;
  ip: string;
  userAgent: string;
  now?: Date;
}): string =>
  createHash("sha256")
    .update(
      [
        input.salt,
        (input.now ?? new Date()).toISOString().slice(0, 10),
        input.ip,
        input.userAgent,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 32);
export const trackedUrl = (publicBaseUrl: string, slug: string): string =>
  `${publicBaseUrl.replace(/\/$/, "")}/go/${slug}`;
/** Captions use the official affiliate URL; old tracked links copied from earlier variants are replaced. */
export const withOfficialLink = (
  caption: string,
  affiliateUrl: string,
  publicBaseUrl?: string,
): string => {
  const base = publicBaseUrl?.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withPlaceholder = base
    ? caption.replace(new RegExp(`${base}/go/[A-Za-z0-9_-]+`, "g"), "{link}")
    : caption;
  return withPlaceholder.replaceAll("{link}", affiliateUrl);
};
