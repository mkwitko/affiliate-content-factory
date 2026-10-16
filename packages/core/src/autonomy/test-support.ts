import {
  OPEN_CANDIDATE_STATES,
  PRODUCT_CANDIDATE_STATES,
  type ProductCandidate,
  type ProductCandidateState,
} from "../research/product-candidate.js";
import type { ProductCandidateRepository } from "../research/product-candidate-repository.js";

/** In-memory ProductCandidateRepository for tests, mirroring the SQL semantics (conditional transition, open-product uniqueness). */
export const fakeCandidateRepository = (
  initial: readonly ProductCandidate[] = [],
): ProductCandidateRepository & { rows: Map<string, ProductCandidate> } => {
  const rows = new Map(initial.map((candidate) => [candidate.id, candidate]));
  const find = (workspaceId: string, id: string) => {
    const row = rows.get(id);
    return row && row.workspaceId === workspaceId ? row : null;
  };
  return {
    rows,
    createMany: async (candidates) => {
      for (const candidate of candidates) rows.set(candidate.id, candidate);
    },
    listForNiche: async ({ workspaceId, nicheId }) =>
      [...rows.values()].filter(
        (row) => row.workspaceId === workspaceId && row.nicheId === nicheId,
      ),
    findForWorkspace: async ({ workspaceId, id }) => find(workspaceId, id),
    findByOffer: async ({ workspaceId, offerId }) =>
      [...rows.values()].find(
        (row) => row.workspaceId === workspaceId && row.offerId === offerId,
      ) ?? null,
    listByState: async ({ workspaceId, nicheId, states, take }) =>
      [...rows.values()]
        .filter(
          (row) =>
            row.workspaceId === workspaceId &&
            (!nicheId || row.nicheId === nicheId) &&
            states.includes(row.state),
        )
        .sort(
          (a, b) =>
            (b.qualification?.heuristic.score ?? -Infinity) -
            (a.qualification?.heuristic.score ?? -Infinity),
        )
        .slice(0, take ?? 50),
    countByState: async ({ workspaceId, nicheId }) => {
      const counts = Object.fromEntries(
        PRODUCT_CANDIDATE_STATES.map((state) => [state, 0]),
      ) as Record<ProductCandidateState, number>;
      for (const row of rows.values())
        if (row.workspaceId === workspaceId && (!nicheId || row.nicheId === nicheId))
          counts[row.state] += 1;
      return counts;
    },
    transition: async ({ workspaceId, id, from, to, at, offerId, qualification }) => {
      const row = find(workspaceId, id);
      if (!row || !from.includes(row.state)) return null;
      if (
        OPEN_CANDIDATE_STATES.includes(to) &&
        [...rows.values()].some(
          (other) =>
            other.id !== id &&
            other.workspaceId === workspaceId &&
            other.providerId === row.providerId &&
            OPEN_CANDIDATE_STATES.includes(other.state),
        )
      )
        throw new Error("product_candidates_open_product_key");
      const { offerId: previousOfferId, ...rest } = row;
      const nextOfferId = offerId === undefined ? previousOfferId : (offerId ?? undefined);
      const updated: ProductCandidate = {
        ...rest,
        state: to,
        ...(nextOfferId ? { offerId: nextOfferId } : {}),
        ...(to === "linked" ? { linkedAt: at } : {}),
        ...(qualification ? { qualification } : {}),
      };
      rows.set(id, updated);
      return updated;
    },
  };
};
