import type { WorkspaceId } from "@money-maker/contracts";
import type { ContinuityFact } from "./story.js";

/** Facts are append-only; a change of state is a new fact that `supersedes` the old one. */
export interface ContinuityRepository {
  append(input: {
    workspaceId: WorkspaceId;
    seriesId: string;
    facts: readonly ContinuityFact[];
  }): Promise<void>;
  /** Every fact of the series in append order (oldest first). */
  listForSeries(input: {
    workspaceId: WorkspaceId;
    seriesId: string;
  }): Promise<readonly ContinuityFact[]>;
}

/** The generator sees at most this many facts (spec 13). */
export const RELEVANT_FACT_LIMIT = 12;

/** Facts not superseded by a later fact and not past `expiresEpisode`. */
export const activeFacts = (
  facts: readonly ContinuityFact[],
  currentEpisode?: number,
): readonly ContinuityFact[] => {
  const superseded = new Set(facts.flatMap((f) => (f.supersedes ? [f.supersedes] : [])));
  return facts.filter(
    (f) =>
      !superseded.has(f.id) &&
      (currentEpisode === undefined ||
        f.expiresEpisode === undefined ||
        currentEpisode <= f.expiresEpisode),
  );
};

/**
 * Active facts that mention the cast (as subject or object), highest salience first, newest
 * first within a salience. `facts` must be in append order.
 */
export const relevantFacts = (input: {
  facts: readonly ContinuityFact[];
  castIds: readonly string[];
  currentEpisode?: number;
  limit?: number;
}): readonly ContinuityFact[] => {
  const cast = new Set(input.castIds);
  const order = new Map(input.facts.map((f, i) => [f.id, i]));
  return activeFacts(input.facts, input.currentEpisode)
    .filter((f) => cast.has(f.subject) || (f.object !== undefined && cast.has(f.object)))
    .sort((a, b) => b.salience - a.salience || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
    .slice(0, input.limit ?? RELEVANT_FACT_LIMIT);
};

/**
 * Deterministic checks before appending `incoming` to `existing`. One item has one holder and
 * one subject is in one place at a time; moving either must supersede the previous fact.
 * Returns violation codes; empty means the batch may be appended.
 */
export const checkNewFacts = (
  existing: readonly ContinuityFact[],
  incoming: readonly ContinuityFact[],
): readonly string[] => {
  const out: string[] = [];
  const known = new Set(existing.map((f) => f.id));
  let state = [...existing];
  for (const fact of incoming) {
    if (known.has(fact.id)) {
      out.push(`duplicate_fact:${fact.id}`);
      continue;
    }
    if (fact.supersedes !== undefined && !known.has(fact.supersedes))
      out.push(`supersedes_unknown:${fact.id}`);
    const active = activeFacts(state).filter((f) => f.id !== fact.supersedes);
    if (fact.kind === "possession" && fact.object !== undefined)
      if (
        active.some(
          (f) => f.kind === "possession" && f.object === fact.object && f.subject !== fact.subject,
        )
      )
        out.push(`possession_conflict:${fact.object}`);
    if (fact.kind === "location" && fact.object !== undefined)
      if (
        active.some(
          (f) => f.kind === "location" && f.subject === fact.subject && f.object !== fact.object,
        )
      )
        out.push(`location_conflict:${fact.subject}`);
    known.add(fact.id);
    state = [...state, fact];
  }
  return out;
};
