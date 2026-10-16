import type { OfferMarketplace } from "../offers/offer.js";
import type { ChannelKind } from "./channel.js";

export type CommerceDestination =
  | "external_link"
  | "profile_link"
  | "manual_shop_attachment"
  | "unsupported";

/** Channel kinds where a Mercado Livre offer's affiliate URL is a valid external destination. */
const mercadoLivreExternalLinkKinds: ReadonlySet<ChannelKind> = new Set([
  "instagram_carousel",
  "instagram_stories",
  "instagram_reels",
  "threads",
  "youtube",
]);

/**
 * Where a bound offer's commerce claim may point on a given channel (design §7, invariant C1). A
 * `tiktok_shop` offer has no external URL, so it is only ever attached in-app on `tiktok_video`. A
 * `mercado_livre` offer on `tiktok_video` points viewers to the profile (Instagram icon or bio
 * link): TikTok captions have no clickable links, so the caption must carry none (ADR 0010
 * amendment 2026-10-01).
 */
export const commerceDestinationFor = (
  channelKind: ChannelKind,
  marketplace: OfferMarketplace,
): CommerceDestination => {
  if (marketplace === "tiktok_shop") {
    return channelKind === "tiktok_video" ? "manual_shop_attachment" : "unsupported";
  }
  if (channelKind === "tiktok_video") return "profile_link";
  return mercadoLivreExternalLinkKinds.has(channelKind) ? "external_link" : "unsupported";
};
