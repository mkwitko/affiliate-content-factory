import type { WorkspaceId } from "@money-maker/contracts";
import type { ApprovalDecision } from "./approval.js";
import type { ContentItem, ContentItemState, ContentVariant, VariantState } from "./content.js";

export interface ContentRepository {
  createContentItem(item: ContentItem): Promise<ContentItem>;
  updateContentItem(item: ContentItem): Promise<ContentItem>;
  listContentItemsForWorkspace?(workspaceId: WorkspaceId): Promise<readonly ContentItem[]>;
  findContentItemForWorkspace(input: {
    workspaceId: WorkspaceId;
    contentItemId: string;
  }): Promise<ContentItem | null>;
  /** Draft items with no variant other than cancelled ones: posts that stopped before a variant. */
  listContentItemsWithoutActiveVariants(
    workspaceId: WorkspaceId,
    options?: Readonly<{ contentItemIds?: readonly string[]; limit?: number }>,
  ): Promise<readonly ContentItem[]>;
  updateContentItemState(input: {
    workspaceId: WorkspaceId;
    contentItemId: string;
    state: ContentItemState;
  }): Promise<ContentItem | null>;
  createVariant(variant: ContentVariant): Promise<ContentVariant>;
  /** Newest update first; `states` filters and `limit` caps the result. */
  listVariantsForWorkspace(
    workspaceId: WorkspaceId,
    options?: Readonly<{ states?: readonly VariantState[]; limit?: number }>,
  ): Promise<readonly ContentVariant[]>;
  findVariantForWorkspace(input: {
    workspaceId: WorkspaceId;
    variantId: string;
  }): Promise<ContentVariant | null>;
  findReviewableForWorkspace(workspaceId: WorkspaceId): Promise<readonly ContentVariant[]>;
  updateVariant(variant: ContentVariant): Promise<ContentVariant>;
  invalidateApprovalsForAssets?(input: {
    workspaceId: WorkspaceId;
    assetIds: readonly string[];
  }): Promise<number>;
  recordApproval(input: {
    workspaceId: WorkspaceId;
    variant: ContentVariant;
    decision: ApprovalDecision;
  }): Promise<ContentVariant>;
}
