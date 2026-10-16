import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelKind } from "../channels/channel.js";

/**
 * A product may be posted again, but only after this many days have passed since its last
 * PUBLISHED attempt on any channel, measured per niche and Mercado Livre product id. A single
 * named constant, not configurable per workspace yet (see AGENTS.md simplicity test).
 */
export const PRODUCT_POST_COOLDOWN_DAYS = 21;

const cooldownMs = PRODUCT_POST_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export const isProductInCooldown = (lastPublishedAt: Date, now: Date = new Date()): boolean =>
  now.getTime() - lastPublishedAt.getTime() < cooldownMs;

export type ProductPostingHistoryEntry = Readonly<{
  /** The Mercado Livre catalog product id (see productIdFromOffer). */
  productId: string;
  offerTitle: string;
  lastPublishedAt: Date;
  publishedCount: number;
  channels: readonly ChannelKind[];
}>;

export interface ProductPostingHistoryRepository {
  /** Every Mercado Livre product ever PUBLISHED for this niche, newest first, workspace-scoped. */
  productPostingHistory(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
  }): Promise<readonly ProductPostingHistoryEntry[]>;
}
