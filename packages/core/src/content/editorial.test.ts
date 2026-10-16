import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  assetRightsFingerprint,
  createContentScript,
  createEditorialReview,
  isCountingEditorialReview,
  withClaimKindDefault,
} from "./editorial.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const fingerprint = "a".repeat(64);

describe("editorial domain", () => {
  it("creates immutable checksummed script versions with only persisted evidence refs", () => {
    const script = createContentScript({
      workspaceId,
      contentItemId: "item-1",
      version: 1,
      body: "A useful explanation.",
      language: "en",
      claims: [
        {
          text: "Observed in research",
          evidence: [
            { kind: "research_observation", observationId: "33333333-3333-4333-8333-333333333333" },
          ],
        },
      ],
      beats: [{ kind: "hook", atChar: 0 }],
      actorId,
    });
    expect(script.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(script)).toBe(true);
    expect(() =>
      createContentScript({
        workspaceId,
        contentItemId: "item-1",
        version: 2,
        body: "No evidence",
        language: "en",
        claims: [{ text: "Fact", evidence: [] }],
        beats: [],
        actorId,
      }),
    ).toThrow("invalid_claim");
  });

  it("derives pass only when all human review checks pass and binds the exact fingerprint", () => {
    const values = {
      originalAngle: "pass",
      meaningfulEditorialInput: "pass",
      visualVariation: "pass",
      sourceGrounding: "pass",
      rightsReviewed: "pass",
      disclosureDecisionReviewed: "pass",
      massProductionRisk: "pass",
      reusedContentRisk: "pass",
      editorialValueIndependentOfAffiliate: "pass",
    } as const;
    const review = createEditorialReview({
      workspaceId,
      variantId: "variant-1",
      publicationFingerprint: fingerprint,
      rightsFingerprint: "b".repeat(64),
      checklist: values,
      verdict: "pass",
      notes: "",
      reviewerId: actorId,
    });
    expect(isCountingEditorialReview(review, fingerprint)).toBe(true);
    expect(isCountingEditorialReview(review, "c".repeat(64))).toBe(false);
    expect(
      createEditorialReview({
        ...review,
        checklist: { ...values, rightsReviewed: "fail" },
        verdict: "fail",
      }).verdict,
    ).toBe("fail");
  });

  it("changes a rights fingerprint when declarations change even if the bytes do not", () => {
    const asset = {
      id: "asset",
      workspaceId,
      objectKey: "key",
      checksum: "same",
      mimeType: "image/png",
      width: 10,
      height: 10,
      provenance: "stock" as const,
      license: "license-1",
      commercialUse: true,
      state: "active" as const,
    };
    expect(assetRightsFingerprint([asset])).not.toBe(
      assetRightsFingerprint([{ ...asset, license: "license-2" }]),
    );
  });
});

describe("claim kinds", () => {
  const base = {
    workspaceId,
    contentItemId: "c1",
    version: 1,
    body: "Body text here.",
    language: "en",
    beats: [],
    actorId,
  };
  const observation = {
    kind: "research_observation" as const,
    observationId: "33333333-3333-4333-8333-333333333333",
  };

  it("defaults kind to verified_fact", () => {
    const script = createContentScript({
      ...base,
      claims: [{ text: "x", evidence: [observation] }],
    });
    expect(script.claims[0]?.kind).toBe("verified_fact");
  });

  it("requires evidence for a verified fact", () => {
    expect(() =>
      createContentScript({
        ...base,
        claims: [{ text: "x", kind: "verified_fact", evidence: [] }],
      }),
    ).toThrow("invalid_claim");
  });

  it("allows an analogy without evidence", () => {
    const script = createContentScript({
      ...base,
      claims: [{ text: "like a bucket", kind: "analogy", evidence: [] }],
    });
    expect(script.claims[0]).toEqual({ text: "like a bucket", kind: "analogy", evidence: [] });
  });

  it("requires a note for a reasonable simplification", () => {
    expect(() =>
      createContentScript({
        ...base,
        claims: [{ text: "banks lend deposits", kind: "reasonable_simplification", evidence: [] }],
      }),
    ).toThrow("invalid_claim");
    const script = createContentScript({
      ...base,
      claims: [
        {
          text: "banks lend deposits",
          kind: "reasonable_simplification",
          note: "ignores reserve rules",
          evidence: [],
        },
      ],
    });
    expect(script.claims[0]?.note).toBe("ignores reserve rules");
  });

  it("reads stored claims without a kind as verified facts", () => {
    expect(withClaimKindDefault([{ text: "old", evidence: [observation] }])).toEqual([
      { text: "old", kind: "verified_fact", evidence: [observation] },
    ]);
  });
});
