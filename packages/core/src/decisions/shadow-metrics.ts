/**
 * Shadow-mode evidence for an advisor (Jev, a local LLM or a hybrid) on a gate decision. The
 * advisor never controls production; this measures whether it could, per decision name, against
 * the human verdict. "reject" covers every non-accept outcome (regenerate, human_review, reject).
 */
export type GateVerdict = "accept" | "reject";
export type ShadowRecord = Readonly<{
  advisor: GateVerdict | null;
  rules: GateVerdict;
  human: GateVerdict | null;
  /** Advisor confidence in its own verdict, 0..1, when it reports one. */
  confidence?: number;
}>;

const rate = (n: number, d: number): number | null => (d ? n / d : null);

export const shadowAgreement = (records: readonly ShadowRecord[]) => {
  const labelled = records.filter((r) => r.human !== null);
  const answered = labelled.filter((r) => r.advisor !== null);
  const count = (f: (r: ShadowRecord) => boolean) => answered.filter(f).length;
  const truePositive = count((r) => r.advisor === "reject" && r.human === "reject");
  const falseReject = count((r) => r.advisor === "reject" && r.human === "accept");
  const falseAccept = count((r) => r.advisor === "accept" && r.human === "reject");
  const withConfidence = answered.filter((r) => r.confidence !== undefined);
  return {
    labelled: labelled.length,
    answered: answered.length,
    advisorAgreement: rate(
      count((r) => r.advisor === r.human),
      answered.length,
    ),
    rulesAgreement: rate(labelled.filter((r) => r.rules === r.human).length, labelled.length),
    /** Advisor accepted what the human rejected: the costly error for unattended use. */
    falseAccept,
    falseReject,
    rejectPrecision: rate(truePositive, truePositive + falseReject),
    rejectRecall: rate(truePositive, truePositive + falseAccept),
    /**
     * Mean |confidence - correct|. ponytail: one bucket (Brier-like); bin it (ECE) once a decision
     * has a few hundred labels.
     */
    calibrationError: rate(
      withConfidence.reduce(
        (sum, r) => sum + Math.abs((r.confidence as number) - (r.advisor === r.human ? 1 : 0)),
        0,
      ),
      withConfidence.length,
    ),
  };
};
