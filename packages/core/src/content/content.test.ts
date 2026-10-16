import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { type Asset, createAsset } from "../assets/asset.js";
import { type Channel, createChannel } from "../channels/channel.js";
import {
  activateOffer,
  addEvidenceSnapshot,
  addRefreshedSnapshot,
  createOffer,
  type Offer,
} from "../offers/offer.js";
import { createProviderConnection } from "../providers/provider-connection.js";
import {
  type ContentVariant,
  createContentItem,
  createVariant,
  validateVariantForReview,
} from "./content.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const otherWorkspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");

const activeOffer = (id = "offer-1", owner = workspaceId): Offer => {
  const draft = createOffer({
    id,
    workspaceId: owner,
    marketplace: "mercado_livre",
    listingUrl: "https://mercadolivre.example/item/1",
    affiliateUrl: "https://affiliate.example/item/1",
    title: "Example product",
  });
  const withEvidence = addEvidenceSnapshot(draft, {
    id: `${id}-snapshot`,
    verifiedAt: new Date("2026-09-20T12:00:00.000Z"),
    facts: [
      {
        key: "seller",
        value: "Example seller",
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
      {
        key: "availability",
        value: "in_stock",
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
      {
        key: "current_price",
        value: { amountMinor: 12990, currency: "BRL" },
        sourceUrl: "https://mercadolivre.example/item/1",
        verified: true,
      },
    ],
  });
  return activateOffer(withEvidence, new Date("2026-09-21T12:00:00.000Z"));
};

const activeChannel = (
  owner = workspaceId,
  kind: Channel["kind"] = "instagram_carousel",
): Channel => {
  const connection = createProviderConnection({
    id: "connection-1",
    workspaceId: owner,
    provider: "post_for_me",
    mode: "api_key",
    secretReference: "secret://workspace/post-for-me",
    accountId: "account-1",
  });
  return createChannel({
    id: "channel-1",
    workspaceId: owner,
    connection,
    kind,
  });
};

const activeAsset = (id = "asset-1", owner = workspaceId): Asset => {
  const result = createAsset({
    id,
    workspaceId: owner,
    mimeType: "image/jpeg",
    checksum: `${id}-checksum`,
    width: 1080,
    height: 1080,
    provenance: "operator_upload",
    license: "operator-owned",
  });
  if (!result.ok) throw new Error("Test asset was rejected");
  return Object.freeze({ ...result.asset, state: "active" as const });
};

const createFixture = () => {
  const offer = activeOffer();
  const item = createContentItem({
    id: "content-1",
    workspaceId,
    nicheId: "niche-1",
    offer,
    title: "A useful product angle",
    sourceFactKeys: ["seller", "current_price"],
    creativeOpinion: "Show the practical use before the product details.",
  });
  const channel = activeChannel();
  const asset = activeAsset();
  const variant = createVariant({
    id: "variant-1",
    workspaceId,
    contentItem: item,
    channel,
    offer,
    assetIds: [asset.id],
    caption: "A practical product idea.",
    language: "pt-BR",
  });
  return { item, offer, channel, asset, variant };
};

describe("content domain", () => {
  it("creates an editorial item without commerce bindings", () => {
    const item = createContentItem({
      workspaceId,
      nicheId: "niche-1",
      title: "A useful idea",
      sourceFactKeys: [],
      creativeOpinion: "Explain the idea clearly.",
    });

    expect(item).toMatchObject({ offerId: null, offerSnapshotId: null, sourceFactKeys: [] });
  });

  it("records one owned parent for a derivative content item", () => {
    const child = createContentItem({
      workspaceId,
      nicheId: "niche-1",
      sourceContentItemId: "master-item",
      title: "A useful short",
      sourceFactKeys: [],
      creativeOpinion: "A standalone insight from the approved master.",
    });
    expect(child.sourceContentItemId).toBe("master-item");
    expect(() =>
      createContentItem({
        id: "master-item",
        workspaceId,
        nicheId: "niche-1",
        sourceContentItemId: "master-item",
        title: "Recursive source",
        sourceFactKeys: [],
        creativeOpinion: "Invalid self reference.",
      }),
    ).toThrow("content_item_source_invalid");
  });

  it("rejects commercial facts and source product pictures without an offer", () => {
    expect(() =>
      createContentItem({
        workspaceId,
        nicheId: "niche-1",
        title: "Editorial",
        sourceFactKeys: ["price"],
        creativeOpinion: "An angle",
      }),
    ).toThrow("Content fact keys require an offer");
    expect(() =>
      createContentItem({
        workspaceId,
        nicheId: "niche-1",
        title: "Editorial",
        sourceFactKeys: [],
        sourcePictureAssetIds: ["asset-1"],
        creativeOpinion: "An angle",
      }),
    ).toThrow("Source pictures require an offer");
  });

  it("creates and reviews an editorial variant without an offer", () => {
    const item = createContentItem({
      workspaceId,
      nicheId: "niche-1",
      title: "Editorial",
      sourceFactKeys: [],
      creativeOpinion: "An angle",
    });
    const channel = activeChannel(workspaceId, "threads");
    const asset = activeAsset();
    const variant = createVariant({
      workspaceId,
      contentItem: item,
      channel,
      assetIds: [asset.id],
      caption: "A useful idea.",
      language: "pt-BR",
    });
    expect(variant.offerSnapshotId).toBeNull();
    expect(
      validateVariantForReview(variant, {
        channel,
        connectionStatus: "active",
        assets: [asset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: true });
  });

  it("stores only facts present in the active commercial snapshot", () => {
    const offer = activeOffer();

    expect(() =>
      createContentItem({
        workspaceId,
        nicheId: "niche-1",
        offer,
        title: "Invalid claim",
        sourceFactKeys: ["unknown_fact"],
        creativeOpinion: "An opinion",
      }),
    ).toThrow("Content fact is not present in the offer snapshot");
  });

  it("creates a workspace-owned draft variant", () => {
    const { item, variant } = createFixture();

    expect(item).toMatchObject({
      workspaceId,
      offerId: "offer-1",
      offerSnapshotId: "offer-1-snapshot",
      sourceFactKeys: ["seller", "current_price"],
    });
    expect(variant).toMatchObject({
      workspaceId,
      contentItemId: item.id,
      state: "draft",
      assetIds: ["asset-1"],
    });
  });

  it("blocks a missing carousel asset sequence", () => {
    const { variant, channel, offer, asset } = createFixture();
    const missingAssetVariant: ContentVariant = Object.freeze({
      ...variant,
      assetIds: [asset.id, "missing-asset"],
    });

    expect(
      validateVariantForReview(missingAssetVariant, {
        channel,
        connectionStatus: "active",
        offer,
        assets: [asset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "asset_sequence_invalid" });
  });

  it("blocks an inactive offer", () => {
    const { variant, channel, asset } = createFixture();
    const inactiveOffer = { ...activeOffer("offer-inactive"), state: "rejected" as const };

    expect(
      validateVariantForReview(variant, {
        channel,
        connectionStatus: "active",
        offer: inactiveOffer,
        assets: [asset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "offer_not_active" });
  });

  it("blocks cross-workspace channel and asset references", () => {
    const { variant, offer, asset } = createFixture();

    expect(
      validateVariantForReview(variant, {
        channel: activeChannel(otherWorkspaceId),
        connectionStatus: "active",
        offer,
        assets: [asset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "workspace_mismatch" });
  });

  it("blocks revoked connections and unsupported assets", () => {
    const { variant, channel, offer } = createFixture();
    const unsupportedAsset = {
      ...activeAsset(),
      id: "asset-1",
      mimeType: "application/pdf",
    } as Asset;

    expect(
      validateVariantForReview(variant, {
        channel,
        connectionStatus: "revoked",
        offer,
        assets: [unsupportedAsset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "connection_inactive" });

    expect(
      validateVariantForReview(variant, {
        channel,
        connectionStatus: "active",
        offer,
        assets: [unsupportedAsset],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "unsupported_asset" });
  });

  it("blocks assets with dimensions unsupported by the target channel", () => {
    const { variant, channel, offer } = createFixture();
    const wrongDimensions = { ...activeAsset(), width: 1, height: 1 };

    expect(
      validateVariantForReview(variant, {
        channel,
        connectionStatus: "active",
        offer,
        assets: [wrongDimensions],
        sourceFactKeys: [],
      }),
    ).toEqual({ ok: false, code: "asset_dimensions_invalid" });
  });
  it("keeps an optional Canva design reference on the variant", () => {
    const { item, offer, channel } = createFixture();
    const variant = createVariant({
      workspaceId,
      contentItem: item,
      channel,
      offer,
      assetIds: ["asset-1", "asset-2"],
      caption: "Caption",
      language: "pt-BR",
      design: { canvaDesignId: "DAF123", pages: [1, 2], width: 1080, height: 1350 },
    });
    expect(variant.design).toEqual({
      canvaDesignId: "DAF123",
      pages: [1, 2],
      width: 1080,
      height: 1350,
    });
  });

  it("rejects a design whose pages do not match the assets", () => {
    const { item, offer, channel } = createFixture();
    expect(() =>
      createVariant({
        workspaceId,
        contentItem: item,
        channel,
        offer,
        assetIds: ["asset-1"],
        caption: "Caption",
        language: "pt-BR",
        design: { canvaDesignId: "DAF123", pages: [1, 2], width: 1080, height: 1350 },
      }),
    ).toThrow("Design pages must match the asset sequence");
  });

  describe("createVariant voiceScript", () => {
    const base = () => {
      const { item, offer } = createFixture();
      return {
        workspaceId,
        contentItem: item,
        channel: activeChannel(),
        offer,
        assetIds: ["a1"],
        caption: "A practical product idea.",
        language: "pt-BR",
      };
    };

    it("accepts one sentence per slide on an instagram_carousel channel", () => {
      const variant = createVariant({
        ...base(),
        assetIds: ["a1", "a2"],
        voiceScript: ["Frase um.", "Frase dois."],
      });
      expect(variant.voiceScript).toEqual(["Frase um.", "Frase dois."]);
    });

    it("defaults to an empty script", () => {
      expect(createVariant(base()).voiceScript).toEqual([]);
    });

    it("rejects a script on a non-carousel channel", () => {
      expect(() =>
        createVariant({
          ...base(),
          channel: activeChannel(workspaceId, "threads"),
          voiceScript: ["x"],
        }),
      ).toThrow("voice_script_unsupported");
    });

    it("rejects a script whose length differs from the slide count", () => {
      expect(() =>
        createVariant({ ...base(), assetIds: ["a1", "a2"], voiceScript: ["só uma"] }),
      ).toThrow("voice_script_length_mismatch");
    });

    it.each([
      ["", "empty"],
      ["   ", "empty"],
      ["x".repeat(201), "too_long"],
      ["Compre #agora", "hashtag"],
      ["Toque em {link}", "link_placeholder"],
      ["🔥🔥", "no_letters"],
    ])("rejects item %j (%s)", (item) => {
      expect(() => createVariant({ ...base(), assetIds: ["a1"], voiceScript: [item] })).toThrow(
        "voice_script_item_invalid",
      );
    });

    it("trims items", () => {
      expect(
        createVariant({ ...base(), assetIds: ["a1"], voiceScript: ["  Olá.  "] }).voiceScript,
      ).toEqual(["Olá."]);
    });
  });

  describe("after a price refresh activates a new snapshot", () => {
    const refreshed = (offer: Offer, price: number): Offer => {
      const snapshot = {
        id: "offer-1-refresh",
        verifiedAt: new Date("2026-09-21T18:00:00.000Z"),
        facts:
          offer.snapshots[0]?.facts.map((fact) =>
            fact.key === "current_price"
              ? { ...fact, value: { amountMinor: price, currency: "BRL" } }
              : fact,
          ) ?? [],
      };
      return { ...addRefreshedSnapshot(offer, snapshot), activeSnapshotId: snapshot.id };
    };

    it("keeps content valid while the facts it cites are unchanged", () => {
      const { item, offer, channel, asset } = createFixture();
      const current = refreshed(offer, 12990);
      const variant = createVariant({
        workspaceId,
        contentItem: item,
        channel,
        offer: current,
        assetIds: [asset.id],
        caption: "A practical product idea.",
        language: "pt-BR",
      });

      expect(variant.offerSnapshotId).toBe("offer-1-snapshot");
      expect(
        validateVariantForReview(variant, {
          channel,
          connectionStatus: "active",
          offer: current,
          assets: [{ ...asset, width: 1080, height: 1350 }],
          sourceFactKeys: item.sourceFactKeys,
        }),
      ).toEqual({ ok: true });
    });

    it("blocks content when a fact it cites changed", () => {
      const { item, offer, channel, asset, variant } = createFixture();
      const current = refreshed(offer, 9990);

      expect(() =>
        createVariant({
          workspaceId,
          contentItem: item,
          channel,
          offer: current,
          assetIds: [asset.id],
          caption: "A practical product idea.",
          language: "pt-BR",
        }),
      ).toThrow("Content variant offer snapshot does not match content item");
      expect(
        validateVariantForReview(variant, {
          channel,
          connectionStatus: "active",
          offer: current,
          assets: [asset],
          sourceFactKeys: item.sourceFactKeys,
        }),
      ).toEqual({ ok: false, code: "offer_snapshot_invalid" });
    });
  });
});
