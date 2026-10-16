import type { WorkspaceId } from "@money-maker/contracts";
import type { CommercialSnapshot, Offer } from "./offer.js";

export type WorkspaceOfferInput = Readonly<{
  workspaceId: WorkspaceId;
  offerId: string;
}>;

export type FindByExternalProductInput = Readonly<{
  workspaceId: WorkspaceId;
  marketplace: Offer["marketplace"];
  externalProductId: string;
}>;

export interface OfferRepository {
  create(offer: Offer): Promise<Offer>;
  listForWorkspace?(workspaceId: WorkspaceId): Promise<readonly Offer[]>;
  /** Every ACTIVE offer across all workspaces; used only by the system refresh loop. */
  listActive?(): Promise<readonly Offer[]>;
  findForWorkspace(input: WorkspaceOfferInput): Promise<Offer | null>;
  /** The existing offer for a (workspace, marketplace, externalProductId), if any. */
  findByExternalProductForWorkspace?(input: FindByExternalProductInput): Promise<Offer | null>;
  addSnapshot(input: WorkspaceOfferInput & { snapshot: CommercialSnapshot }): Promise<Offer | null>;
  activate(input: WorkspaceOfferInput & { snapshotId: string }): Promise<Offer | null>;
  reject(input: WorkspaceOfferInput & { reason: string }): Promise<Offer | null>;
}
