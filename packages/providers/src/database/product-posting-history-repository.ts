import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelKind } from "@money-maker/core/channels/channel";
import { productIdFromOffer, type CommercialSnapshot } from "@money-maker/core/offers/offer";
import type {
  ProductPostingHistoryEntry,
  ProductPostingHistoryRepository,
} from "@money-maker/core/offers/product-posting-history";
import type { DatabaseClient } from "./client.js";

export class PrismaProductPostingHistoryRepository implements ProductPostingHistoryRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async productPostingHistory(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
  }): Promise<readonly ProductPostingHistoryEntry[]> {
    const attempts = await this.client.publicationAttempt.findMany({
      where: {
        workspaceId: input.workspaceId,
        status: "PUBLISHED",
        contentVariant: { contentItem: { nicheId: input.nicheId, offer: { isNot: null } } },
      },
      // Newest first: the first attempt seen per product id below is its latest publication.
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      include: {
        channel: true,
        contentVariant: {
          include: {
            contentItem: {
              include: { offer: { include: { snapshots: { select: { id: true } } } } },
            },
          },
        },
      },
    });

    type Accumulated = {
      offerTitle: string;
      lastPublishedAt: Date;
      publishedCount: number;
      channels: Set<ChannelKind>;
    };
    const byProduct = new Map<string, Accumulated>();
    for (const attempt of attempts) {
      const offer = attempt.contentVariant.contentItem.offer;
      if (!offer) continue;
      const productId = productIdFromOffer({
        listingUrl: offer.listingUrl,
        snapshots: offer.snapshots as unknown as readonly CommercialSnapshot[],
      });
      if (!productId) continue;
      const channelKind = attempt.channel.kind.toLowerCase() as ChannelKind;
      const existing = byProduct.get(productId);
      if (existing) {
        existing.publishedCount += 1;
        existing.channels.add(channelKind);
        continue;
      }
      byProduct.set(productId, {
        offerTitle: offer.title,
        lastPublishedAt: attempt.publishedAt ?? attempt.createdAt,
        publishedCount: 1,
        channels: new Set([channelKind]),
      });
    }

    return [...byProduct.entries()].map(([productId, entry]) => ({
      productId,
      offerTitle: entry.offerTitle,
      lastPublishedAt: entry.lastPublishedAt,
      publishedCount: entry.publishedCount,
      channels: [...entry.channels],
    }));
  }
}
