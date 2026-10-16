import type { WorkspaceId } from "@money-maker/contracts";
import { isValidMercadoLivreLabel } from "./attribution.js";

export type ConversionEvidence = Readonly<{
  source: "mercado_livre_afiliados";
  workspaceId: WorkspaceId;
  evidenceReference: string;
}> &
  (
    | Readonly<{
        scope: "publication";
        attributionBasis: "provider_reported";
        externalPublicationReference: string;
        publicationAttemptId: string;
      }>
    | Readonly<{
        scope: "label_aggregate";
        attributionBasis: "label_aggregate";
        marketplaceLabel: string;
      }>
    | Readonly<{ scope: "account_aggregate"; attributionBasis: "unattributed" }>
  );

/** Only an exact, workspace-scoped reference resolver may attach a sale to a publication. */
export const classifyConversionEvidence = (
  input: Readonly<{
    workspaceId: WorkspaceId;
    evidenceReference: string;
    externalPublicationReference?: string;
    marketplaceLabel?: string;
  }>,
  resolvePublicationAttempt: (input: {
    workspaceId: WorkspaceId;
    externalPublicationReference: string;
  }) => string | null,
): ConversionEvidence => {
  if (!input.evidenceReference.trim()) throw new Error("evidence_reference_required");
  if (input.marketplaceLabel && !isValidMercadoLivreLabel(input.marketplaceLabel))
    throw new Error("invalid_marketplace_label");
  const reference = input.externalPublicationReference?.trim();
  if (reference) {
    const publicationAttemptId = resolvePublicationAttempt({
      workspaceId: input.workspaceId,
      externalPublicationReference: reference,
    });
    if (publicationAttemptId)
      return {
        source: "mercado_livre_afiliados",
        workspaceId: input.workspaceId,
        evidenceReference: input.evidenceReference,
        scope: "publication",
        attributionBasis: "provider_reported",
        externalPublicationReference: reference,
        publicationAttemptId,
      };
  }
  if (input.marketplaceLabel)
    return {
      source: "mercado_livre_afiliados",
      workspaceId: input.workspaceId,
      evidenceReference: input.evidenceReference,
      scope: "label_aggregate",
      attributionBasis: "label_aggregate",
      marketplaceLabel: input.marketplaceLabel,
    };
  return {
    source: "mercado_livre_afiliados",
    workspaceId: input.workspaceId,
    evidenceReference: input.evidenceReference,
    scope: "account_aggregate",
    attributionBasis: "unattributed",
  };
};

/**
 * What the reports say about sales (owner brief 2026-10-08, Phase 9): a count per attribution
 * basis and a plain sentence, so a report with clicks and no sale says "no attributed sale"
 * instead of staying silent. Never infers a sale or revenue from clicks.
 */
export type SalesStatement = Readonly<{
  attributedToPublications: number;
  labelAggregate: number;
  unattributed: number;
  statement: string;
}>;
export const salesStatement = (evidence: readonly ConversionEvidence[]): SalesStatement => {
  const count = (basis: ConversionEvidence["attributionBasis"]) =>
    evidence.filter((entry) => entry.attributionBasis === basis).length;
  const attributed = count("provider_reported");
  const label = count("label_aggregate");
  const unattributed = count("unattributed");
  const parts = [
    attributed > 0
      ? `${attributed} sale(s) attributed to publications by the marketplace`
      : "no attributed sale",
    ...(label > 0 ? [`${label} sale(s) known only per affiliate label`] : []),
    ...(unattributed > 0 ? [`${unattributed} sale(s) on the account with no attribution`] : []),
    ...(evidence.length === 0 ? ["no sale evidence has been recorded"] : []),
  ];
  return {
    attributedToPublications: attributed,
    labelAggregate: label,
    unattributed,
    statement: parts.join("; "),
  };
};
