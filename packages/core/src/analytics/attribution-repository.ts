import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelKind } from "../channels/channel.js";
import type { Money } from "../offers/offer.js";
import type {
  AttributionGroupBy,
  AttributionRow,
  ClickEvent,
  RedirectRecord,
  TrackingSlug,
} from "./attribution.js";
/** One published variant of an offer, a candidate card for the niche's bio storefront page. */
export type NicheStorefrontCandidate = Readonly<{
  offerId: string;
  offerTitle: string;
  /** The offer's safe affiliate URL; the card's fallback when the variant has no tracked link. */
  affiliateUrl: string;
  contentVariantId: string;
  channelKind: ChannelKind;
  /** The variant's first slide; absent when it has no assets, so it cannot become a card. */
  assetId?: string;
  publishedAt: Date;
  /** Prices and availability recorded in the offer's active commercial snapshot, when it has one. */
  activeSnapshot?: Readonly<{
    verifiedAt: Date;
    currentPrice?: Money;
    listPrice?: Money;
    /** False only when a refresh found the listing delisted or out of stock. */
    available?: boolean;
  }>;
}>;
/** Every published-and-sellable candidate for a niche's public bio page. */
export type NicheStorefront = Readonly<{
  workspaceId: WorkspaceId;
  nicheName: string;
  /** Instagram handle of the account that published the niche's posts, when any. */
  instagramHandle?: string;
  candidates: readonly NicheStorefrontCandidate[];
}>;
export interface AttributionRepository {
  createRedirect(record: RedirectRecord): Promise<RedirectRecord>;
  findBySlug(slug: TrackingSlug): Promise<RedirectRecord | null>;
  findForVariant(input: {
    workspaceId: WorkspaceId;
    contentVariantId: string;
  }): Promise<RedirectRecord | null>;
  findForPublicationAttempt?(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
  }): Promise<RedirectRecord | null>;
  /** Null for an unknown niche slug; otherwise the niche's candidates, possibly empty. */
  findNicheStorefront(nicheSlug: string): Promise<NicheStorefront | null>;
  recordClick(event: ClickEvent): Promise<void>;
  summary(
    workspaceId: WorkspaceId,
    options: Readonly<{ groupBy: AttributionGroupBy; since?: Date; until?: Date }>,
  ): Promise<readonly AttributionRow[]>;
}
