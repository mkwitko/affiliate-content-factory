import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { classifyConversionEvidence, salesStatement } from "./conversion-evidence.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

describe("conversion evidence", () => {
  it("associates a publication only through an exact external reference mapping", () => {
    const evidence = classifyConversionEvidence(
      {
        workspaceId,
        evidenceReference: "report:sha256:abc",
        externalPublicationReference: "provider-post-17",
      },
      ({ workspaceId: resolvedWorkspace, externalPublicationReference }) =>
        resolvedWorkspace === workspaceId && externalPublicationReference === "provider-post-17"
          ? "publication-attempt-17"
          : null,
    );

    expect(evidence).toEqual({
      source: "mercado_livre_afiliados",
      workspaceId,
      evidenceReference: "report:sha256:abc",
      scope: "publication",
      attributionBasis: "provider_reported",
      externalPublicationReference: "provider-post-17",
      publicationAttemptId: "publication-attempt-17",
    });
  });

  it("keeps label evidence at the aggregate label scope", () => {
    const evidence = classifyConversionEvidence(
      { workspaceId, evidenceReference: "report:sha256:abc", marketplaceLabel: "instagram_casa" },
      () => null,
    );

    expect(evidence).toMatchObject({
      scope: "label_aggregate",
      marketplaceLabel: "instagram_casa",
    });
    expect(evidence).not.toHaveProperty("publicationAttemptId");
  });

  it("does not match an unknown publication reference by label, product, date, or channel", () => {
    const evidence = classifyConversionEvidence(
      {
        workspaceId,
        evidenceReference: "report:sha256:abc",
        externalPublicationReference: "unknown-post",
        marketplaceLabel: "instagram_casa",
      },
      () => null,
    );

    expect(evidence).toMatchObject({
      scope: "label_aggregate",
      marketplaceLabel: "instagram_casa",
    });
    expect(evidence).not.toHaveProperty("publicationAttemptId");
  });

  it("rejects evidence without a source reference", () => {
    expect(() =>
      classifyConversionEvidence({ workspaceId, evidenceReference: "  " }, () => null),
    ).toThrow("evidence_reference_required");
  });

  it("rejects a label name that cannot be a Mercado Livre label", () => {
    expect(() =>
      classifyConversionEvidence(
        { workspaceId, evidenceReference: "report:sha256:abc", marketplaceLabel: "Casa Casa" },
        () => null,
      ),
    ).toThrow("invalid_marketplace_label");
  });
});

describe("sales statement", () => {
  it("says no attributed sale plainly when there is no evidence", () => {
    expect(salesStatement([])).toEqual({
      attributedToPublications: 0,
      labelAggregate: 0,
      unattributed: 0,
      statement: "no attributed sale; no sale evidence has been recorded",
    });
  });
  it("keeps account-level sales apart from attributed ones", () => {
    const unattributed = classifyConversionEvidence(
      { workspaceId, evidenceReference: "report:1" },
      () => null,
    );
    expect(salesStatement([unattributed]).statement).toBe(
      "no attributed sale; 1 sale(s) on the account with no attribution",
    );
  });
});
