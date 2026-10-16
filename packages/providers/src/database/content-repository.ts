import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ApprovalDecision } from "@money-maker/core/content/approval";
import type {
  ContentItem,
  ContentVariant,
  CreativeFeatures,
} from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const itemStateToDatabase = (state: ContentItem["state"]): "DRAFT" | "CANCELLED" =>
  state.toUpperCase() as "DRAFT" | "CANCELLED";
const variantStateToDatabase = (
  state: ContentVariant["state"],
):
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "SCHEDULED"
  | "PUBLISHED"
  | "CANCELLED" =>
  state.toUpperCase() as
    | "DRAFT"
    | "READY_FOR_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "SCHEDULED"
    | "PUBLISHED"
    | "CANCELLED";

const itemToDomain = (record: {
  id: string;
  workspaceId: string;
  nicheId: string;
  offerId: string | null;
  sourceContentItemId: string | null;
  offerSnapshotId: string | null;
  title: string;
  sourceFactKeys: string[];
  sourcePictureAssetIds?: string[];
  creativeSlides?: unknown;
  creativeOpinion: string;
  state: "DRAFT" | "CANCELLED";
}): ContentItem =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    nicheId: record.nicheId,
    offerId: record.offerId,
    ...(record.sourceContentItemId ? { sourceContentItemId: record.sourceContentItemId } : {}),
    offerSnapshotId: record.offerSnapshotId,
    title: record.title,
    sourceFactKeys: Object.freeze([...record.sourceFactKeys]),
    ...(record.sourcePictureAssetIds?.length
      ? { sourcePictureAssetIds: Object.freeze([...record.sourcePictureAssetIds]) }
      : {}),
    ...(Array.isArray(record.creativeSlides)
      ? { creativeSlides: record.creativeSlides as NonNullable<ContentItem["creativeSlides"]> }
      : {}),
    creativeOpinion: record.creativeOpinion,
    state: record.state.toLowerCase() as ContentItem["state"],
  });

type VariantRecord = {
  id: string;
  workspaceId: string;
  contentItemId: string;
  channelId: string;
  offerSnapshotId: string | null;
  assetIds: string[];
  caption: string;
  language: string;
  state:
    | "DRAFT"
    | "READY_FOR_REVIEW"
    | "APPROVED"
    | "REJECTED"
    | "SCHEDULED"
    | "PUBLISHED"
    | "CANCELLED";
  rejectionReason: string | null;
  canvaDesignId: string | null;
  canvaPages: number[];
  canvaWidth: number | null;
  canvaHeight: number | null;
  creativeFeatures?: unknown;
  creativeRender?: unknown;
  voiceScript: string[];
  publishSpec: unknown;
  approvals?: Array<{
    id: string;
    workspaceId: string;
    variantId: string;
    actorId: string;
    assetChecksums: string[];
    offerSnapshotId: string | null;
    publicationFingerprint: string | null;
    policyVersion: number;
    decidedAt: Date;
  }>;
};

const variantToDomain = (record: VariantRecord): ContentVariant => {
  const approvalRecord = record.approvals?.[0];
  return Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    contentItemId: record.contentItemId,
    channelId: record.channelId,
    offerSnapshotId: record.offerSnapshotId,
    assetIds: Object.freeze([...record.assetIds]),
    caption: record.caption,
    language: record.language,
    state: record.state.toLowerCase() as ContentVariant["state"],
    ...(record.rejectionReason ? { rejectionReason: record.rejectionReason } : {}),
    ...(record.canvaDesignId && record.canvaWidth && record.canvaHeight
      ? {
          design: Object.freeze({
            canvaDesignId: record.canvaDesignId,
            pages: Object.freeze([...record.canvaPages]),
            width: record.canvaWidth,
            height: record.canvaHeight,
          }),
        }
      : {}),
    ...(record.creativeFeatures && typeof record.creativeFeatures === "object"
      ? { creativeFeatures: record.creativeFeatures as CreativeFeatures }
      : {}),
    ...(record.creativeRender && typeof record.creativeRender === "object"
      ? { creativeRender: record.creativeRender as NonNullable<ContentVariant["creativeRender"]> }
      : {}),
    voiceScript: Object.freeze([...record.voiceScript]),
    ...(record.publishSpec && typeof record.publishSpec === "object"
      ? { publishSpec: record.publishSpec as NonNullable<ContentVariant["publishSpec"]> }
      : {}),
    ...(approvalRecord
      ? {
          approval: Object.freeze({
            id: approvalRecord.id,
            workspaceId: parseWorkspaceId(approvalRecord.workspaceId),
            variantId: approvalRecord.variantId,
            actorId: parseUserId(approvalRecord.actorId),
            assetChecksums: Object.freeze([...approvalRecord.assetChecksums]),
            offerSnapshotId: approvalRecord.offerSnapshotId,
            publicationFingerprint: approvalRecord.publicationFingerprint,
            policyVersion: approvalRecord.policyVersion,
            decidedAt: approvalRecord.decidedAt,
          }),
        }
      : {}),
  });
};

const includeVariant = {
  approvals: {
    orderBy: { decidedAt: "desc" as const },
    take: 1,
  },
};

export class PrismaContentRepository implements ContentRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listContentItemsForWorkspace(
    workspaceId: ContentItem["workspaceId"],
  ): Promise<readonly ContentItem[]> {
    const records = await this.client.contentItem.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: "desc" },
    });
    return records.map(itemToDomain);
  }

  public async listContentItemsWithoutActiveVariants(
    workspaceId: ContentItem["workspaceId"],
    options: Readonly<{ contentItemIds?: readonly string[]; limit?: number }> = {},
  ): Promise<readonly ContentItem[]> {
    const records = await this.client.contentItem.findMany({
      where: {
        workspaceId,
        state: "DRAFT",
        variants: { none: { state: { not: "CANCELLED" } } },
        ...(options.contentItemIds ? { id: { in: [...options.contentItemIds] } } : {}),
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(options.limit ? { take: options.limit } : {}),
    });
    return records.map(itemToDomain);
  }

  public async updateContentItemState(input: {
    workspaceId: ContentItem["workspaceId"];
    contentItemId: string;
    state: ContentItem["state"];
  }): Promise<ContentItem | null> {
    const updated = await this.client.contentItem.updateMany({
      where: { id: input.contentItemId, workspaceId: input.workspaceId },
      data: { state: itemStateToDatabase(input.state) },
    });
    if (updated.count === 0) return null;
    return this.findContentItemForWorkspace({
      workspaceId: input.workspaceId,
      contentItemId: input.contentItemId,
    });
  }

  public async createContentItem(item: ContentItem): Promise<ContentItem> {
    const record = await this.client.contentItem.create({
      data: {
        id: item.id,
        workspaceId: item.workspaceId,
        nicheId: item.nicheId,
        offerId: item.offerId,
        sourceContentItemId: item.sourceContentItemId ?? null,
        offerSnapshotId: item.offerSnapshotId,
        title: item.title,
        sourceFactKeys: [...item.sourceFactKeys],
        sourcePictureAssetIds: [...(item.sourcePictureAssetIds ?? [])],
        ...(item.creativeSlides ? { creativeSlides: [...item.creativeSlides] } : {}),
        creativeOpinion: item.creativeOpinion,
        state: itemStateToDatabase(item.state),
      },
    });
    return itemToDomain(record);
  }

  public async updateContentItem(item: ContentItem): Promise<ContentItem> {
    const updated = await this.client.contentItem.updateMany({
      where: { id: item.id, workspaceId: item.workspaceId },
      data: {
        ...(item.creativeSlides ? { creativeSlides: [...item.creativeSlides] } : {}),
        sourcePictureAssetIds: [...(item.sourcePictureAssetIds ?? [])],
      },
    });
    if (updated.count === 0) throw new Error("content_item_not_found");
    const record = await this.client.contentItem.findFirst({
      where: { id: item.id, workspaceId: item.workspaceId },
    });
    if (!record) throw new Error("content_item_not_found");
    return itemToDomain(record);
  }

  public async findContentItemForWorkspace(input: {
    workspaceId: ContentItem["workspaceId"];
    contentItemId: string;
  }): Promise<ContentItem | null> {
    const record = await this.client.contentItem.findFirst({
      where: { id: input.contentItemId, workspaceId: input.workspaceId },
    });
    return record ? itemToDomain(record) : null;
  }

  public async createVariant(variant: ContentVariant): Promise<ContentVariant> {
    const record = await this.client.contentVariant.create({
      data: {
        id: variant.id,
        workspaceId: variant.workspaceId,
        contentItemId: variant.contentItemId,
        channelId: variant.channelId,
        offerSnapshotId: variant.offerSnapshotId,
        assetIds: [...variant.assetIds],
        caption: variant.caption,
        language: variant.language,
        state: variantStateToDatabase(variant.state),
        rejectionReason: variant.rejectionReason ?? null,
        canvaDesignId: variant.design?.canvaDesignId ?? null,
        canvaPages: variant.design ? [...variant.design.pages] : [],
        canvaWidth: variant.design?.width ?? null,
        canvaHeight: variant.design?.height ?? null,
        ...(variant.creativeFeatures ? { creativeFeatures: { ...variant.creativeFeatures } } : {}),
        ...(variant.creativeRender ? { creativeRender: { ...variant.creativeRender } } : {}),
        voiceScript: [...variant.voiceScript],
        ...(variant.publishSpec ? { publishSpec: { ...variant.publishSpec } } : {}),
      },
      include: includeVariant,
    });
    return variantToDomain(record as unknown as VariantRecord);
  }

  public async findVariantForWorkspace(input: {
    workspaceId: ContentVariant["workspaceId"];
    variantId: string;
  }): Promise<ContentVariant | null> {
    const record = await this.client.contentVariant.findFirst({
      where: { id: input.variantId, workspaceId: input.workspaceId },
      include: includeVariant,
    });
    return record ? variantToDomain(record as unknown as VariantRecord) : null;
  }

  public async listVariantsForWorkspace(
    workspaceId: ContentVariant["workspaceId"],
    options: Readonly<{ states?: readonly ContentVariant["state"][]; limit?: number }> = {},
  ): Promise<readonly ContentVariant[]> {
    const records = await this.client.contentVariant.findMany({
      where: {
        workspaceId,
        ...(options.states ? { state: { in: options.states.map(variantStateToDatabase) } } : {}),
      },
      include: includeVariant,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      ...(options.limit ? { take: options.limit } : {}),
    });
    return records.map((record) => variantToDomain(record as unknown as VariantRecord));
  }

  public async findReviewableForWorkspace(
    workspaceId: ContentVariant["workspaceId"],
  ): Promise<readonly ContentVariant[]> {
    const records = await this.client.contentVariant.findMany({
      where: { workspaceId, state: "READY_FOR_REVIEW" },
      include: includeVariant,
      orderBy: { createdAt: "asc" },
    });
    return Object.freeze(
      records.map((record) => variantToDomain(record as unknown as VariantRecord)),
    );
  }

  public async updateVariant(variant: ContentVariant): Promise<ContentVariant> {
    const updated = await this.client.contentVariant.updateMany({
      where: { id: variant.id, workspaceId: variant.workspaceId },
      data: {
        assetIds: [...variant.assetIds],
        caption: variant.caption,
        language: variant.language,
        state: variantStateToDatabase(variant.state),
        rejectionReason: variant.rejectionReason ?? null,
        canvaDesignId: variant.design?.canvaDesignId ?? null,
        canvaPages: variant.design ? [...variant.design.pages] : [],
        canvaWidth: variant.design?.width ?? null,
        canvaHeight: variant.design?.height ?? null,
        creativeFeatures: variant.creativeFeatures
          ? { ...variant.creativeFeatures }
          : Prisma.DbNull,
        creativeRender: variant.creativeRender ? { ...variant.creativeRender } : Prisma.DbNull,
        voiceScript: [...variant.voiceScript],
        publishSpec: variant.publishSpec ? { ...variant.publishSpec } : Prisma.DbNull,
      },
    });
    if (updated.count === 0) throw new Error("Content variant not found");
    const result = await this.findVariantForWorkspace({
      workspaceId: variant.workspaceId,
      variantId: variant.id,
    });
    if (!result) throw new Error("Content variant not found");
    return result;
  }

  public async invalidateApprovalsForAssets(input: {
    workspaceId: ContentVariant["workspaceId"];
    assetIds: readonly string[];
  }): Promise<number> {
    if (input.assetIds.length === 0) return 0;
    const result = await this.client.contentVariant.updateMany({
      where: {
        workspaceId: input.workspaceId,
        state: { in: ["APPROVED", "SCHEDULED", "READY_FOR_REVIEW"] },
        OR: [
          { assetIds: { hasSome: [...input.assetIds] } },
          ...input.assetIds.map((assetId) => ({
            publishSpec: { path: ["thumbnailAssetId"], equals: assetId },
          })),
        ],
      },
      data: { state: "DRAFT" },
    });
    return result.count;
  }

  public async recordApproval(input: {
    workspaceId: ContentVariant["workspaceId"];
    variant: ContentVariant;
    decision: ApprovalDecision;
  }): Promise<ContentVariant> {
    await this.client.$transaction(async (transaction) => {
      const updated = await transaction.contentVariant.updateMany({
        where: { id: input.variant.id, workspaceId: input.workspaceId },
        data: { state: "APPROVED", rejectionReason: null },
      });
      if (updated.count === 0) throw new Error("Content variant not found");
      await transaction.contentApproval.create({
        data: {
          id: input.decision.id,
          workspaceId: input.workspaceId,
          variantId: input.variant.id,
          actorId: input.decision.actorId,
          assetChecksums: [...input.decision.assetChecksums],
          offerSnapshotId: input.decision.offerSnapshotId,
          publicationFingerprint: input.decision.publicationFingerprint,
          policyVersion: input.decision.policyVersion,
          decidedAt: input.decision.decidedAt,
        },
      });
    });
    const result = await this.findVariantForWorkspace({
      workspaceId: input.workspaceId,
      variantId: input.variant.id,
    });
    if (!result) throw new Error("Content variant not found");
    return result;
  }
}
