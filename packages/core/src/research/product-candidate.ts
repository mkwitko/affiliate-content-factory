import type { WorkspaceId } from "@money-maker/contracts";

export const PRODUCT_CANDIDATE_STATES = [
  "discovered",
  "awaiting_affiliate_link",
  "linked",
  "in_production",
  "consumed",
  "rejected",
  "expired",
  "duplicate",
] as const;
export type ProductCandidateState = (typeof PRODUCT_CANDIDATE_STATES)[number];
/** States that hold a product slot: at most one open candidate per workspace and product. */
export const OPEN_CANDIDATE_STATES: readonly ProductCandidateState[] = [
  "awaiting_affiliate_link",
  "linked",
  "in_production",
];

export type CandidateQualification = Readonly<{
  version: 1;
  facts: Readonly<{
    rating: number | null;
    reviewCount: number | null;
    soldQuantity: number | null;
    listPriceMinor: number | null;
    freeShipping: boolean | null;
    observedAt: string;
    /** Kept so the link queue can stay varied (one per brand, two per category). */
    brand?: string | null;
    domainId?: string | null;
  }>;
  heuristic: Readonly<{ score: number; parts: Readonly<Record<string, number>> }>;
  hypotheses: readonly string[];
  buyerVoice: Readonly<{
    topPraise: string | null;
    topComplaint: string | null;
    firstQuestion: string | null;
    untrusted: true;
  }> | null;
  reasons: readonly string[];
}>;

const ALLOWED_EDGES: Readonly<Record<ProductCandidateState, readonly ProductCandidateState[]>> = {
  discovered: ["awaiting_affiliate_link", "rejected", "duplicate"],
  awaiting_affiliate_link: ["linked", "expired"],
  linked: ["in_production", "awaiting_affiliate_link", "rejected"],
  in_production: ["consumed", "rejected"],
  consumed: [],
  rejected: [],
  expired: [],
  duplicate: [],
};

export const transitionCandidate = (
  from: ProductCandidateState,
  to: ProductCandidateState,
): boolean => ALLOWED_EDGES[from].includes(to);

export type ProductCandidate = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  nicheId: string;
  policyId: string;
  providerId: string;
  title: string;
  listingUrl: string;
  seller: string;
  availability: string;
  priceMinor: number;
  currency: string;
  rank: number;
  /** Mercado Livre best-seller position in the product's category when discovery saw one. */
  bestSellerRank?: number;
  discoveredAt: Date;
  state: ProductCandidateState;
  offerId?: string;
  qualifiedAt?: Date;
  linkedAt?: Date;
  qualification?: CandidateQualification;
}>;
