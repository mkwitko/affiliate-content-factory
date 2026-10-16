import type { WorkspaceId } from "@money-maker/contracts";
import type {
  CandidateQualification,
  ProductCandidate,
  ProductCandidateState,
} from "./product-candidate.js";

export interface ProductCandidateRepository {
  createMany(candidates: readonly ProductCandidate[]): Promise<void>;
  /** `take` bounds the result set: default 50, max 200. Newest run first, then rank. */
  listForNiche(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
    since?: Date;
    take?: number;
  }): Promise<readonly ProductCandidate[]>;
  findForWorkspace(input: {
    workspaceId: WorkspaceId;
    id: string;
  }): Promise<ProductCandidate | null>;
  /** The candidate linked to an offer, if any (at most one open candidate per product). */
  findByOffer(input: {
    workspaceId: WorkspaceId;
    offerId: string;
  }): Promise<ProductCandidate | null>;
  /** Ordered by heuristic score desc, then discoveredAt desc. `take` default 50, max 200. */
  listByState(input: {
    workspaceId: WorkspaceId;
    nicheId?: string;
    states: readonly ProductCandidateState[];
    take?: number;
  }): Promise<readonly ProductCandidate[]>;
  countByState(input: {
    workspaceId: WorkspaceId;
    nicheId?: string;
  }): Promise<Readonly<Record<ProductCandidateState, number>>>;
  /**
   * Conditional update; returns null when the row is not in one of `from` (lost race or already
   * moved). `offerId: null` clears the link; `undefined` leaves it. Callers check
   * `transitionCandidate` for the edge; `from` may repeat `to` to update fields in place.
   */
  transition(input: {
    workspaceId: WorkspaceId;
    id: string;
    from: readonly ProductCandidateState[];
    to: ProductCandidateState;
    at: Date;
    offerId?: string | null;
    qualification?: CandidateQualification;
  }): Promise<ProductCandidate | null>;
}
