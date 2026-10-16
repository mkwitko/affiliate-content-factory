import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import type {
  AttributionRepository,
  NicheStorefront,
  NicheStorefrontCandidate,
} from "@money-maker/core/analytics/attribution-repository";
import type { ChannelKind } from "@money-maker/core/channels/channel";
import type { Money } from "@money-maker/core/offers/offer";
import type {
  AttributionGroupBy,
  AttributionRow,
  ClickEvent,
  RedirectRecord,
  TrackingSlug,
} from "@money-maker/core/analytics/attribution";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type TrackedLinkRecord = {
  slug: string;
  workspaceId: string;
  contentVariantId: string | null;
  publicationAttemptId: string | null;
  offerId: string | null;
  marketplaceLabel: string | null;
  destination: string;
  destinationFingerprint: string;
  fallbackUrl: string | null;
  expiresAt: Date;
};

const toDomain = (record: TrackedLinkRecord): RedirectRecord => ({
  slug: record.slug as TrackingSlug,
  workspaceId: parseWorkspaceId(record.workspaceId),
  destination: record.destination,
  destinationFingerprint: record.destinationFingerprint,
  expiresAt: record.expiresAt,
  ...(record.contentVariantId ? { contentVariantId: record.contentVariantId } : {}),
  ...(record.publicationAttemptId ? { publicationAttemptId: record.publicationAttemptId } : {}),
  ...(record.offerId ? { offerId: record.offerId } : {}),
  ...(record.marketplaceLabel ? { marketplaceLabel: record.marketplaceLabel } : {}),
  ...(record.fallbackUrl ? { fallbackUrl: record.fallbackUrl } : {}),
});

type StorefrontSnapshot = NonNullable<NicheStorefrontCandidate["activeSnapshot"]>;

const moneyFact = (value: unknown): Money | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { amountMinor, currency } = value as Record<string, unknown>;
  return Number.isInteger(amountMinor) && typeof currency === "string"
    ? { amountMinor: amountMinor as number, currency }
    : undefined;
};

/** A refresh records `false` when the listing is delisted or out of stock; any other value (the
 * usual `"available"` string from an import) means the offer was sellable as of that snapshot. */
const availabilityFact = (value: unknown): boolean | undefined =>
  value === undefined ? undefined : value !== false;

const isSafeDestination = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

// Whitelisted grouping columns; never interpolate caller input into SQL.
const groupColumn: Record<AttributionGroupBy, Prisma.Sql> = {
  publication: Prisma.sql`c.publication_attempt_id`,
  variant: Prisma.sql`c.content_variant_id`,
  contentItem: Prisma.sql`v.content_item_id`,
  niche: Prisma.sql`i.niche_id`,
  channel: Prisma.sql`v.channel_id`,
};

export class PrismaAttributionRepository implements AttributionRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createRedirect(record: RedirectRecord): Promise<RedirectRecord> {
    await this.client.trackedLink.create({
      data: {
        slug: record.slug,
        workspaceId: record.workspaceId,
        contentVariantId: record.contentVariantId ?? null,
        publicationAttemptId: record.publicationAttemptId ?? null,
        offerId: record.offerId ?? null,
        marketplaceLabel: record.marketplaceLabel ?? null,
        destination: record.destination,
        destinationFingerprint: record.destinationFingerprint,
        fallbackUrl: record.fallbackUrl ?? null,
        expiresAt: record.expiresAt,
      },
    });
    return record;
  }

  public async findBySlug(slug: TrackingSlug): Promise<RedirectRecord | null> {
    const record = await this.client.trackedLink.findUnique({ where: { slug } });
    return record ? toDomain(record) : null;
  }

  public async findForVariant(input: {
    workspaceId: WorkspaceId;
    contentVariantId: string;
  }): Promise<RedirectRecord | null> {
    const record = await this.client.trackedLink.findFirst({
      where: { workspaceId: input.workspaceId, contentVariantId: input.contentVariantId },
      orderBy: { createdAt: "desc" },
    });
    return record ? toDomain(record) : null;
  }

  public async findForPublicationAttempt(input: {
    workspaceId: WorkspaceId;
    attemptId: string;
  }): Promise<RedirectRecord | null> {
    const record = await this.client.trackedLink.findFirst({
      where: { workspaceId: input.workspaceId, publicationAttemptId: input.attemptId },
    });
    return record ? toDomain(record) : null;
  }

  public async findNicheStorefront(nicheSlug: string): Promise<NicheStorefront | null> {
    const niche = await this.client.niche.findUnique({ where: { slug: nicheSlug } });
    if (!niche) return null;
    const attempts = await this.client.publicationAttempt.findMany({
      where: {
        workspaceId: niche.workspaceId,
        status: "PUBLISHED",
        contentVariant: { contentItem: { nicheId: niche.id, offer: { is: { state: "ACTIVE" } } } },
      },
      orderBy: [{ publishedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      include: {
        channel: true,
        connection: true,
        contentVariant: { include: { contentItem: { include: { offer: true } } } },
      },
    });
    const snapshots = await this.activeSnapshotPrices(
      niche.workspaceId,
      attempts.flatMap((attempt) => {
        const offer = attempt.contentVariant.contentItem.offer;
        return offer?.activeSnapshotId ? [offer.activeSnapshotId] : [];
      }),
    );
    const candidates: NicheStorefrontCandidate[] = [];
    for (const attempt of attempts) {
      const offer = attempt.contentVariant.contentItem.offer;
      if (!offer) continue;
      if (!offer.affiliateUrl || !isSafeDestination(offer.affiliateUrl)) continue;
      const activeSnapshot = offer.activeSnapshotId
        ? snapshots.get(offer.activeSnapshotId)
        : undefined;
      candidates.push({
        offerId: offer.id,
        offerTitle: offer.title,
        affiliateUrl: offer.affiliateUrl,
        contentVariantId: attempt.contentVariantId,
        channelKind: attempt.channel.kind.toLowerCase() as ChannelKind,
        ...(attempt.contentVariant.assetIds[0]
          ? { assetId: attempt.contentVariant.assetIds[0] }
          : {}),
        publishedAt: attempt.publishedAt ?? attempt.createdAt,
        ...(activeSnapshot ? { activeSnapshot } : {}),
      });
    }
    const handle = attempts.find(
      (attempt) => attempt.channel.kind.startsWith("INSTAGRAM") && attempt.connection.displayName,
    )?.connection.displayName;
    return {
      workspaceId: parseWorkspaceId(niche.workspaceId),
      nicheName: niche.name,
      ...(handle ? { instagramHandle: handle } : {}),
      candidates,
    };
  }

  /** Verified current/list price facts of the given snapshots, keyed by snapshot id. */
  private async activeSnapshotPrices(
    workspaceId: string,
    snapshotIds: readonly (string | null)[],
  ): Promise<Map<string, StorefrontSnapshot>> {
    const ids = [...new Set(snapshotIds.filter((id): id is string => id !== null))];
    if (!ids.length) return new Map();
    const rows = await this.client.commercialSnapshot.findMany({
      where: { workspaceId, id: { in: ids } },
      include: {
        facts: {
          where: { verified: true, key: { in: ["current_price", "list_price", "availability"] } },
        },
      },
    });
    return new Map(
      rows.map((row) => {
        const fact = (key: string) => row.facts.find((entry) => entry.key === key)?.value;
        const currentPrice = moneyFact(fact("current_price"));
        const listPrice = moneyFact(fact("list_price"));
        const available = availabilityFact(fact("availability"));
        return [
          row.id,
          {
            verifiedAt: row.verifiedAt,
            ...(currentPrice ? { currentPrice } : {}),
            ...(listPrice ? { listPrice } : {}),
            ...(available !== undefined ? { available } : {}),
          },
        ];
      }),
    );
  }

  public async recordClick(event: ClickEvent): Promise<void> {
    await this.client.clickEvent.create({
      data: {
        workspaceId: event.workspaceId,
        slug: event.slug ?? null,
        contentVariantId: event.contentVariantId ?? null,
        publicationAttemptId: event.publicationAttemptId ?? null,
        via: event.via,
        expired: event.expired,
        visitorHash: event.visitorHash,
        referrerHost: event.referrerHost ?? null,
      },
    });
  }

  public async summary(
    workspaceId: WorkspaceId,
    options: Readonly<{ groupBy: AttributionGroupBy; since?: Date; until?: Date }>,
  ): Promise<readonly AttributionRow[]> {
    const rows = await this.client.$queryRaw<
      { key: string | null; clicks: number; unique_clicks: number; last_click_at: Date }[]
    >(Prisma.sql`
      SELECT ${groupColumn[options.groupBy]} AS key,
             count(*)::int AS clicks,
             count(DISTINCT c.visitor_hash)::int AS unique_clicks,
             max(c.occurred_at) AS last_click_at
      FROM click_events c
      LEFT JOIN content_variants v
        ON v.id = c.content_variant_id AND v.workspace_id = c.workspace_id
      LEFT JOIN content_items i
        ON i.id = v.content_item_id AND i.workspace_id = c.workspace_id
      WHERE c.workspace_id = ${workspaceId}::uuid
        AND c.occurred_at >= ${options.since ?? new Date(0)}
        AND c.occurred_at < ${options.until ?? new Date("9999-12-31T00:00:00Z")}
      GROUP BY 1
      ORDER BY clicks DESC
    `);
    return rows.map((row) => ({
      key: row.key ?? "unattributed",
      clicks: row.clicks,
      uniqueClicks: row.unique_clicks,
      lastClickAt: row.last_click_at,
    }));
  }
}
