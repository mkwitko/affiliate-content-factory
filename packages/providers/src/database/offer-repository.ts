import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import type {
  CommercialFactValue,
  CommercialSnapshot,
  Money,
  Offer as DomainOffer,
} from "@money-maker/core/offers/offer";
import type { OfferRepository } from "@money-maker/core/offers/offer-repository";
import type { DatabaseClient } from "./client.js";

type OfferRecord = {
  id: string;
  workspaceId: string;
  marketplace: "MERCADO_LIVRE" | "TIKTOK_SHOP";
  listingUrl: string;
  affiliateUrl: string | null;
  externalProductId: string | null;
  title: string;
  listPriceMinor: number | null;
  listPriceCurrency: string | null;
  currentPriceMinor: number | null;
  currentPriceCurrency: string | null;
  discountMinor: number | null;
  discountCurrency: string | null;
  shippingMinor: number | null;
  shippingCurrency: string | null;
  commissionMinor: number | null;
  commissionCurrency: string | null;
  feesMinor: number | null;
  feesCurrency: string | null;
  revenueMinor: number | null;
  revenueCurrency: string | null;
  state: "DRAFT" | "ACTIVE" | "REJECTED" | "ARCHIVED";
  activeSnapshotId: string | null;
  rejectionReason: string | null;
  snapshots: Array<{
    id: string;
    verifiedAt: Date;
    facts: Array<{
      id: string;
      key: string;
      value: unknown;
      sourceUrl: string;
      verified: boolean;
    }>;
  }>;
};

const stateToDatabase = (state: DomainOffer["state"]): OfferRecord["state"] =>
  state.toUpperCase() as OfferRecord["state"];

const stateToDomain = (state: OfferRecord["state"]): DomainOffer["state"] =>
  state.toLowerCase() as DomainOffer["state"];

const marketplaceToDatabase = (
  marketplace: DomainOffer["marketplace"],
): OfferRecord["marketplace"] => (marketplace === "tiktok_shop" ? "TIKTOK_SHOP" : "MERCADO_LIVRE");

const marketplaceToDomain = (
  marketplace: OfferRecord["marketplace"],
): DomainOffer["marketplace"] => (marketplace === "TIKTOK_SHOP" ? "tiktok_shop" : "mercado_livre");

const money = (amountMinor: number | null, currency: string | null): Money | undefined => {
  if (amountMinor === null && currency === null) return undefined;
  if (amountMinor === null || currency === null) throw new Error("Persisted money is incomplete");
  return { amountMinor, currency };
};

const factValue = (value: unknown): CommercialFactValue => {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "amountMinor" in value &&
    "currency" in value &&
    typeof value.amountMinor === "number" &&
    typeof value.currency === "string"
  ) {
    return { amountMinor: value.amountMinor, currency: value.currency };
  }
  throw new Error("Persisted commercial fact value is invalid");
};

const toDomain = (record: OfferRecord): DomainOffer => {
  const snapshots: CommercialSnapshot[] = record.snapshots.map((snapshot) =>
    Object.freeze({
      id: snapshot.id,
      verifiedAt: snapshot.verifiedAt,
      facts: Object.freeze(
        snapshot.facts.map((fact) =>
          Object.freeze({
            key: fact.key,
            value: factValue(fact.value),
            sourceUrl: fact.sourceUrl,
            verified: fact.verified,
          }),
        ),
      ),
    }),
  );
  const values = {
    listPrice: money(record.listPriceMinor, record.listPriceCurrency),
    currentPrice: money(record.currentPriceMinor, record.currentPriceCurrency),
    discount: money(record.discountMinor, record.discountCurrency),
    shipping: money(record.shippingMinor, record.shippingCurrency),
    commission: money(record.commissionMinor, record.commissionCurrency),
    fees: money(record.feesMinor, record.feesCurrency),
    revenue: money(record.revenueMinor, record.revenueCurrency),
  };
  return Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    marketplace: marketplaceToDomain(record.marketplace),
    listingUrl: record.listingUrl,
    ...(record.affiliateUrl ? { affiliateUrl: record.affiliateUrl } : {}),
    ...(record.externalProductId ? { externalProductId: record.externalProductId } : {}),
    title: record.title,
    ...Object.fromEntries(
      Object.entries(values).filter((entry): entry is [string, Money] => entry[1] !== undefined),
    ),
    state: stateToDomain(record.state),
    snapshots: Object.freeze(snapshots),
    ...(record.activeSnapshotId ? { activeSnapshotId: record.activeSnapshotId } : {}),
    ...(record.rejectionReason ? { rejectionReason: record.rejectionReason } : {}),
  }) as DomainOffer;
};

const includeOffer = {
  snapshots: {
    include: { facts: { orderBy: { key: "asc" as const } } },
    orderBy: { verifiedAt: "asc" as const },
  },
};

const moneyData = (moneyValue: Money | undefined) =>
  moneyValue
    ? { minor: moneyValue.amountMinor, currency: moneyValue.currency }
    : { minor: null, currency: null };

export class PrismaOfferRepository implements OfferRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listForWorkspace(
    workspaceId: DomainOffer["workspaceId"],
  ): Promise<readonly DomainOffer[]> {
    const records = await this.client.offer.findMany({
      where: { workspaceId },
      include: includeOffer,
      orderBy: { updatedAt: "desc" },
    });
    return records.map((record) => toDomain(record as unknown as OfferRecord));
  }

  public async listActive(): Promise<readonly DomainOffer[]> {
    const records = await this.client.offer.findMany({
      where: { state: "ACTIVE" },
      include: includeOffer,
      orderBy: { updatedAt: "asc" },
    });
    return records.map((record) => toDomain(record as unknown as OfferRecord));
  }

  public async create(offer: DomainOffer): Promise<DomainOffer> {
    const listPrice = moneyData(offer.listPrice);
    const currentPrice = moneyData(offer.currentPrice);
    const discount = moneyData(offer.discount);
    const shipping = moneyData(offer.shipping);
    const commission = moneyData(offer.commission);
    const fees = moneyData(offer.fees);
    const revenue = moneyData(offer.revenue);
    const record = await this.client.offer.create({
      data: {
        id: offer.id,
        workspaceId: offer.workspaceId,
        marketplace: marketplaceToDatabase(offer.marketplace),
        listingUrl: offer.listingUrl,
        affiliateUrl: offer.affiliateUrl ?? null,
        externalProductId: offer.externalProductId ?? null,
        title: offer.title,
        listPriceMinor: listPrice.minor,
        listPriceCurrency: listPrice.currency,
        currentPriceMinor: currentPrice.minor,
        currentPriceCurrency: currentPrice.currency,
        discountMinor: discount.minor,
        discountCurrency: discount.currency,
        shippingMinor: shipping.minor,
        shippingCurrency: shipping.currency,
        commissionMinor: commission.minor,
        commissionCurrency: commission.currency,
        feesMinor: fees.minor,
        feesCurrency: fees.currency,
        revenueMinor: revenue.minor,
        revenueCurrency: revenue.currency,
        state: stateToDatabase(offer.state),
        activeSnapshotId: offer.activeSnapshotId ?? null,
        rejectionReason: offer.rejectionReason ?? null,
      },
      include: includeOffer,
    });
    return toDomain(record as OfferRecord);
  }

  public async findForWorkspace(input: {
    workspaceId: DomainOffer["workspaceId"];
    offerId: string;
  }): Promise<DomainOffer | null> {
    const record = await this.client.offer.findFirst({
      where: { id: input.offerId, workspaceId: input.workspaceId },
      include: includeOffer,
    });
    return record ? toDomain(record as unknown as OfferRecord) : null;
  }

  public async findByExternalProductForWorkspace(input: {
    workspaceId: DomainOffer["workspaceId"];
    marketplace: DomainOffer["marketplace"];
    externalProductId: string;
  }): Promise<DomainOffer | null> {
    const record = await this.client.offer.findFirst({
      where: {
        workspaceId: input.workspaceId,
        marketplace: marketplaceToDatabase(input.marketplace),
        externalProductId: input.externalProductId,
      },
      include: includeOffer,
    });
    return record ? toDomain(record as unknown as OfferRecord) : null;
  }

  public async addSnapshot(input: {
    workspaceId: DomainOffer["workspaceId"];
    offerId: string;
    snapshot: CommercialSnapshot;
  }): Promise<DomainOffer | null> {
    const offer = await this.client.offer.findFirst({
      where: { id: input.offerId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!offer) return null;
    await this.client.commercialSnapshot.create({
      data: {
        id: input.snapshot.id,
        offerId: input.offerId,
        workspaceId: input.workspaceId,
        verifiedAt: input.snapshot.verifiedAt,
        facts: {
          create: input.snapshot.facts.map((fact) => ({
            id: randomUUID(),
            key: fact.key,
            value: fact.value,
            sourceUrl: fact.sourceUrl,
            verified: fact.verified,
          })),
        },
      },
    });
    return this.findForWorkspace({ workspaceId: input.workspaceId, offerId: input.offerId });
  }

  public async activate(input: {
    workspaceId: DomainOffer["workspaceId"];
    offerId: string;
    snapshotId: string;
  }): Promise<DomainOffer | null> {
    const snapshot = await this.client.commercialSnapshot.findFirst({
      where: { id: input.snapshotId, offerId: input.offerId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!snapshot) return null;
    const updated = await this.client.offer.updateMany({
      where: { id: input.offerId, workspaceId: input.workspaceId },
      data: { state: "ACTIVE", activeSnapshotId: input.snapshotId, rejectionReason: null },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, offerId: input.offerId });
  }

  public async reject(input: {
    workspaceId: DomainOffer["workspaceId"];
    offerId: string;
    reason: string;
  }): Promise<DomainOffer | null> {
    const updated = await this.client.offer.updateMany({
      where: { id: input.offerId, workspaceId: input.workspaceId },
      data: { state: "REJECTED", rejectionReason: input.reason },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, offerId: input.offerId });
  }
}
