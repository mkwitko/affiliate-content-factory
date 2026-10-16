import { describe, expect, it } from "vitest";
import {
  captionHasDisclosure,
  captionMissingCta,
  countHashtags,
  hashtagFromKeyword,
  numbersWithoutEvidence,
  previewContent,
} from "./preview-content.js";

const channel = (
  kind: "instagram_stories" | "threads" | "instagram_carousel" | "instagram_reels",
) => ({
  id: "c",
  workspaceId: "w" as never,
  connectionId: "x",
  kind,
  label: kind,
  status: "active" as const,
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/png"],
    captionMaxLength: 2200,
    ...(kind === "instagram_stories"
      ? { requiredAssetDimensions: { width: 1080, height: 1920 } }
      : {}),
  },
});
const variant = {
  id: "v",
  workspaceId: "w" as never,
  contentItemId: "i",
  channelId: "c",
  offerSnapshotId: "s",
  assetIds: ["a"],
  caption: "caption",
  language: "pt-BR",
  state: "draft" as const,
  voiceScript: [] as readonly string[],
};
describe("content preview", () => {
  it("previews editorial content without commerce warnings", () => {
    const preview = previewContent({
      variant: { ...variant, offerSnapshotId: null, caption: "An independent useful idea." },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });
    expect(preview).toMatchObject({ evidenceAgeDays: null, destinationFingerprint: null });
    expect(preview.warnings).not.toContain("disclosure_missing");
    expect(preview.warnings).not.toContain("cta_missing");
  });

  it("warns when a Threads post uses more than one hashtag", () => {
    const preview = previewContent({
      variant: { ...variant, offerSnapshotId: null, caption: "Useful idea #tech #AI" },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });

    expect(preview.warnings).toContain("threads_multiple_topic_tags");
  });

  it("warns on generic reach hashtags without blocking the preview", () => {
    const preview = previewContent({
      variant: { ...variant, offerSnapshotId: null, caption: "Useful idea #FYP #viral #trending" },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });

    expect(preview.warnings).toEqual(
      expect.arrayContaining([
        "generic_hashtag:fyp",
        "generic_hashtag:viral",
        "generic_hashtag:trending",
      ]),
    );
    expect(preview.nextAction).toBe("approve");
  });

  it("does not warn on a single specific Threads topic tag", () => {
    const preview = previewContent({
      variant: { ...variant, offerSnapshotId: null, caption: "Useful idea #casaorganizada" },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });

    expect(preview.warnings).not.toContain("threads_multiple_topic_tags");
    expect(preview.warnings).not.toContain("generic_hashtag:fyp");
  });

  it("warns when a caption opens with generic filler instead of a specific hook", () => {
    const preview = previewContent({
      variant: {
        ...variant,
        offerSnapshotId: null,
        caption: "Você não vai acreditar no que mudou. A altura da tela afeta o pescoço.",
      },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });

    expect(preview.warnings).toContain("hook_generic");
    expect(preview.nextAction).toBe("approve");
  });

  it("does not warn when the opening hook names a specific problem", () => {
    const preview = previewContent({
      variant: {
        ...variant,
        offerSnapshotId: null,
        caption: "Sua tela baixa força o pescoço a inclinar. Veja o ajuste.",
      },
      channel: channel("threads"),
      assets: [],
      evidence: { kind: "editorial" },
    });

    expect(preview.warnings).not.toContain("hook_generic");
  });

  it("selects native CTA and ordered assets", () => {
    const asset = {
      id: "a",
      workspaceId: "w" as never,
      objectKey: "hidden",
      checksum: "x",
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      provenance: "generated" as const,
      commercialUse: null,
      license: "ai",
      state: "active" as const,
    };
    expect(
      previewContent({
        variant,
        channel: channel("instagram_stories"),
        assets: [asset],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      }).cta,
    ).toEqual({ mode: "link_in_bio" });
  });
  it("tells the operator the next action is approve", () => {
    expect(
      previewContent({
        variant: { ...variant, assetIds: [] },
        channel: channel("threads"),
        assets: [],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      }).nextAction,
    ).toBe("approve");
  });
  it("rejects story dimensions in carousel", () => {
    const asset = {
      id: "a",
      workspaceId: "w" as never,
      objectKey: "hidden",
      checksum: "x",
      mimeType: "image/png",
      width: 1080,
      height: 1920,
      provenance: "generated" as const,
      commercialUse: null,
      license: "ai",
      state: "active" as const,
    };
    expect(() =>
      previewContent({
        variant,
        channel: {
          ...channel("instagram_carousel"),
          capabilities: {
            ...channel("instagram_carousel").capabilities,
            requiredAssetDimensions: { width: 1080, height: 1350 },
          },
        },
        assets: [asset],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      }),
    ).toThrow("asset_dimensions_invalid");
  });
  it("exposes the design reference and a Canva edit link", () => {
    const preview = previewContent({
      variant: {
        ...variant,
        assetIds: [],
        design: {
          canvaDesignId: "DAF123",
          pages: [1],
          width: 1080,
          height: 1350,
        },
      },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "fp",
    });
    expect(preview.design?.canvaDesignId).toBe("DAF123");
    expect(preview.editUrl).toBe("https://www.canva.com/design/DAF123/edit");
  });
  it("returns null design and editUrl for plain-photo variants", () => {
    const preview = previewContent({
      variant: { ...variant, assetIds: [] },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "fp",
    });
    expect(preview.design).toBeNull();
    expect(preview.editUrl).toBeNull();
  });
});
describe("commercial claims in the caption", () => {
  const url = "https://www.mercadolivre.com.br/p/MLB1";
  const facts = [
    {
      key: "current_price",
      value: { amountMinor: 3790, currency: "BRL" },
      sourceUrl: url,
      verified: true,
    },
    {
      key: "list_price",
      value: { amountMinor: 5490, currency: "BRL" },
      sourceUrl: url,
      verified: true,
    },
    { key: "discount_percent", value: 31, sourceUrl: url, verified: true },
    { key: "sold_quantity", value: 12000, sourceUrl: url, verified: true },
    { key: "rating_average", value: 4.8, sourceUrl: url, verified: true },
    { key: "review_count", value: 9231, sourceUrl: url, verified: true },
  ];
  it("accepts prices, discount, rating, counts and rounded counts backed by facts", () => {
    expect(
      numbersWithoutEvidence(
        "#publi De R$ 54,90 por R$ 37,90 (31% off, R$ 17 a menos). Nota 4,8 com 9.231 avaliações, +10 mil vendidos. 1/7",
        facts,
      ),
    ).toEqual([]);
  });
  it("lists each commercial number no fact supports", () => {
    expect(
      numbersWithoutEvidence(
        "Só R$ 29,90, 40% off, nota 4.9, 20 mil vendidos e 500 avaliações",
        facts,
      ),
    ).toEqual(["R$ 29,90", "40%", "nota 4.9", "20 mil vendidos", "500 avaliações"]);
  });
  it("ignores spec numbers that are not commercial claims", () => {
    expect(
      numbersWithoutEvidence(
        "Serve para notebooks de 10 a 17 polegadas, Bluetooth 5.3, 2,4 GHz, 100% algodão",
        facts,
      ),
    ).toEqual([]);
  });
  it("accepts rounded-down counts, a one-decimal rating, and prices without thousand dots", () => {
    const more = [
      {
        key: "current_price",
        value: { amountMinor: 129990, currency: "BRL" },
        sourceUrl: url,
        verified: true,
      },
      { key: "sold_quantity", value: 540, sourceUrl: url, verified: true },
      { key: "review_count", value: 20500, sourceUrl: url, verified: true },
      { key: "rating_average", value: 4.67, sourceUrl: url, verified: true },
    ];
    expect(
      numbersWithoutEvidence(
        "+500 vendidos, nota 4,7, 4,7 estrelas, R$1299,90 ou R$ 1.299,90",
        more,
      ),
    ).toEqual([]);
    expect(
      numbersWithoutEvidence("+20 mil avaliações, +20 mil vendidos e +900 vendidos", more),
    ).toEqual(["+20 mil vendidos", "+900 vendidos"]);
  });
  it("warns in the preview for a missing disclosure and unsupported numbers", () => {
    const preview = previewContent({
      variant: { ...variant, assetIds: [], caption: "Só R$ 29,90 hoje" },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "sha",
      facts,
    });
    expect(preview.warnings).toEqual(["disclosure_missing", "number_without_evidence:R$ 29,90"]);
  });
  it("warns on a voice line number with no evidence", () => {
    const withoutReviewCount = facts.filter((fact) => fact.key !== "review_count");
    const preview = previewContent({
      variant: { ...variant, assetIds: [], voiceScript: ["Mais de 900 avaliações."] },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "sha",
      facts: withoutReviewCount,
    });
    expect(preview.warnings).toContain("voice_number_without_evidence:900 avaliações");
  });
  it("does not warn when a fact backs the voice line number", () => {
    const backedFacts = [
      ...facts.filter((fact) => fact.key !== "review_count"),
      { key: "review_count", value: 900, sourceUrl: url, verified: true },
    ];
    const preview = previewContent({
      variant: { ...variant, assetIds: [], voiceScript: ["Mais de 900 avaliações."] },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "sha",
      facts: backedFacts,
    });
    expect(preview.warnings).not.toContain("voice_number_without_evidence:900 avaliações");
  });
  it("does not check voice line numbers without facts", () => {
    const preview = previewContent({
      variant: { ...variant, assetIds: [], voiceScript: ["Mais de 900 avaliações."] },
      channel: channel("threads"),
      assets: [],
      evidenceVerifiedAt: new Date(),
      destinationFingerprint: "sha",
    });
    expect(
      preview.warnings.some((warning) => warning.startsWith("voice_number_without_evidence")),
    ).toBe(false);
  });
});
describe("disclosure and hashtags", () => {
  it("accepts #publi anywhere as a whole hashtag", () => {
    expect(captionHasDisclosure("Oferta boa\n\n#publi #casa")).toBe(true);
    expect(captionHasDisclosure("#Publi oferta")).toBe(true);
    expect(captionHasDisclosure("oferta #publicidade")).toBe(true);
    expect(captionHasDisclosure("oferta #publico")).toBe(false);
    expect(captionHasDisclosure("oferta publi")).toBe(false);
  });
  it("turns a trend keyword into one hashtag", () => {
    expect(hashtagFromKeyword("Fone de ouvido Bluetooth")).toBe("#fonedeouvidobluetooth");
    expect(hashtagFromKeyword("decoração sala")).toBe("#decoraçãosala");
    expect(hashtagFromKeyword("iphone 15")).toBe("#iphone15");
    expect(hashtagFromKeyword("2026")).toBeNull();
    expect(hashtagFromKeyword(" - ")).toBeNull();
  });
  it("counts hashtags with accents", () => {
    expect(countHashtags("#publi #decoração #casa_nova texto #1")).toBe(4);
  });
  it("warns a feed caption past Instagram's 5-hashtag limit, counting #publi", () => {
    const warningsFor = (kind: "instagram_carousel" | "threads", tags: string) =>
      previewContent({
        variant: {
          ...variant,
          assetIds: [],
          caption: `🔗 Link na bio\n\n${tags}`,
        },
        channel: channel(kind),
        assets: [],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      }).warnings;
    expect(warningsFor("instagram_carousel", "#publi #a #b #c #d #e")).toEqual([
      "too_many_hashtags",
    ]);
    expect(warningsFor("instagram_carousel", "#publi #a #b #c #d")).toEqual([]);
    expect(warningsFor("threads", "#publi #a #b #c #d #e")).toContain(
      "threads_multiple_topic_tags",
    );
  });
});
describe("the feed/Reels CTA and durable-price warnings", () => {
  it("flags a feed caption missing the fixed CTA formula", () => {
    expect(captionMissingCta("#publi Veja a oferta e confira os detalhes no Mercado Livre.")).toBe(
      true,
    );
  });
  it("accepts the CTA regardless of case", () => {
    expect(captionMissingCta("#publi ... 🔗 link na bio")).toBe(false);
  });
  it("warns cta_missing on instagram_carousel and instagram_reels captions without it", () => {
    for (const kind of ["instagram_carousel", "instagram_reels"] as const) {
      const preview = previewContent({
        variant: {
          ...variant,
          caption: "#publi Veja a oferta no Mercado Livre.",
        },
        channel: channel(kind),
        assets: [],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      });
      expect(preview.warnings).toContain("cta_missing");
    }
  });
  it("never requires the feed CTA on stories or threads", () => {
    for (const kind of ["instagram_stories", "threads"] as const) {
      const preview = previewContent({
        variant: {
          ...variant,
          caption: "#publi Veja a oferta no Mercado Livre.",
        },
        channel: channel(kind),
        assets: [],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      });
      expect(preview.warnings).not.toContain("cta_missing");
    }
  });
});
