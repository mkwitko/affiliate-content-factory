/**
 * Blind pairwise judging for the model arena. A judge (human or VLM) sees two outputs for the
 * same case in a display order (left/right) without model names. The arena asks every pair twice
 * with the order swapped; a verdict that follows the slot instead of the output is position bias
 * and counts as a tie.
 */
export type PairwiseWinner = "left" | "right" | "tie" | "reject_both";
export type PairwiseJudgment = Readonly<{
  caseId: string;
  left: string;
  right: string;
  winner: PairwiseWinner;
  /** "human" or "vlm:<model id>"; judgments are only reconciled with the same judge. */
  judge: string;
  reasons?: readonly string[];
}>;
export type PairwiseOutcome = Readonly<{
  caseId: string;
  judge: string;
  /** a < b in code-point order, so both display orders reconcile to one outcome. */
  a: string;
  b: string;
  result: "a" | "b" | "tie" | "reject_both";
  positionBias: boolean;
}>;

const normalized = (j: PairwiseJudgment) => {
  const swap = j.left > j.right;
  const [a, b] = swap ? [j.right, j.left] : [j.left, j.right];
  const result =
    j.winner === "tie" || j.winner === "reject_both"
      ? j.winner
      : (j.winner === "left") !== swap
        ? ("a" as const)
        : ("b" as const);
  return { a, b, result };
};

export const reconcileJudgments = (
  judgments: readonly PairwiseJudgment[],
): readonly PairwiseOutcome[] => {
  const groups = new Map<string, ReturnType<typeof normalized>[]>();
  const keys = new Map<string, Readonly<{ caseId: string; judge: string }>>();
  for (const j of judgments) {
    if (j.left === j.right) continue;
    const n = normalized(j);
    const key = JSON.stringify([j.caseId, j.judge, n.a, n.b]);
    groups.set(key, [...(groups.get(key) ?? []), n]);
    keys.set(key, { caseId: j.caseId, judge: j.judge });
  }
  return [...groups].map(([key, verdicts]) => {
    const { caseId, judge } = keys.get(key) as { caseId: string; judge: string };
    const first = verdicts[0] as ReturnType<typeof normalized>;
    const agree = verdicts.every((v) => v.result === first.result);
    return {
      caseId,
      judge,
      a: first.a,
      b: first.b,
      result: agree ? first.result : "tie",
      positionBias: !agree,
    };
  });
};

export type RankedCandidate = Readonly<{
  id: string;
  /** Elo-like scale: 400 * log10(strength), mean 0. Only comparable within one ranking. */
  score: number;
  wins: number;
  losses: number;
  ties: number;
  rejected: number;
  comparisons: number;
}>;

const ITERATIONS = 200;
/**
 * Bradley-Terry fitted with the MM algorithm (Hunter 2004). Ties count as half a win for each
 * side. Every model also plays one virtual win and one virtual loss against a unit-strength
 * anchor, which keeps clean sweeps finite (a weak prior that shrinks small samples toward 0).
 * ponytail: no confidence intervals; add a bootstrap over cases when rankings are close.
 */
export const bradleyTerry = (outcomes: readonly PairwiseOutcome[]): readonly RankedCandidate[] => {
  const ids = [...new Set(outcomes.flatMap((o) => [o.a, o.b]))].sort();
  const stats = new Map(
    ids.map((id) => [id, { wins: 0, losses: 0, ties: 0, rejected: 0, comparisons: 0 }]),
  );
  const games = new Map<string, number>();
  const pair = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  for (const o of outcomes) {
    const sa = stats.get(o.a) as NonNullable<ReturnType<typeof stats.get>>;
    const sb = stats.get(o.b) as NonNullable<ReturnType<typeof stats.get>>;
    if (o.result === "reject_both") {
      sa.rejected += 1;
      sb.rejected += 1;
      continue;
    }
    sa.comparisons += 1;
    sb.comparisons += 1;
    if (o.result === "tie") {
      sa.ties += 1;
      sb.ties += 1;
    } else {
      const [w, l] = o.result === "a" ? [sa, sb] : [sb, sa];
      w.wins += 1;
      l.losses += 1;
    }
    games.set(pair(o.a, o.b), (games.get(pair(o.a, o.b)) ?? 0) + 1);
  }
  let strength = new Map(ids.map((id) => [id, 1]));
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const next = new Map<string, number>();
    for (const id of ids) {
      const s = stats.get(id) as NonNullable<ReturnType<typeof stats.get>>;
      const p = strength.get(id) as number;
      // Anchor: one win + one loss against strength 1 => numerator +1, denominator +2/(p+1).
      let denominator = 2 / (p + 1);
      for (const other of ids) {
        if (other === id) continue;
        const n = games.get(pair(id, other)) ?? 0;
        if (n) denominator += n / (p + (strength.get(other) as number));
      }
      next.set(id, (s.wins + s.ties / 2 + 1) / denominator);
    }
    strength = next;
  }
  const logs = ids.map((id) => Math.log10(strength.get(id) as number));
  const mean = logs.reduce((sum, v) => sum + v, 0) / Math.max(1, logs.length);
  return ids
    .map((id, i) => ({
      id,
      score: Math.round(400 * ((logs[i] as number) - mean) * 10) / 10,
      ...(stats.get(id) as NonNullable<ReturnType<typeof stats.get>>),
    }))
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
};

/** Challenger's win rate against one opponent; ties count half; reject_both is excluded. */
export const headToHead = (
  outcomes: readonly PairwiseOutcome[],
  challenger: string,
  opponent: string,
): Readonly<{ comparisons: number; winRate: number | null }> => {
  let points = 0;
  let comparisons = 0;
  for (const o of outcomes) {
    const mine = o.a === challenger ? "a" : o.b === challenger ? "b" : null;
    if (!mine || (o.a !== opponent && o.b !== opponent) || o.result === "reject_both") continue;
    comparisons += 1;
    points += o.result === "tie" ? 0.5 : o.result === mine ? 1 : 0;
  }
  return { comparisons, winRate: comparisons ? points / comparisons : null };
};
