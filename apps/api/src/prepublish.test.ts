import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import { prepublishScoreFor } from "./prepublish.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-30T12:00:00Z");
const item = {
  id: "i",
  workspaceId,
  nicheId: "n",
  offerId: "o",
  offerSnapshotId: "s",
  title: "t",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
  creativeSlides: [{ index: 0, total: 1, template: "hero", headline: "Confira isto", claims: [] }],
} as unknown as ContentItem;
const variant = (features: Partial<NonNullable<ContentVariant["creativeFeatures"]>> = {}) =>
  ({
    id: "v",
    workspaceId,
    contentItemId: "i",
    channelId: "c",
    offerSnapshotId: "s",
    assetIds: [],
    caption: "c",
    language: "pt-BR",
    state: "draft",
    voiceScript: [],
    creativeFeatures: { priceShown: true, discountShown: false, ...features },
  }) as unknown as ContentVariant;
const channel = { id: "c", kind: "instagram_carousel" } as Channel;
const offer = (verifiedAt: string) =>
  ({ snapshots: [{ id: "s", verifiedAt: new Date(verifiedAt), facts: [] }] }) as unknown as Offer;

describe("prepublishScoreFor", () => {
  it("blocks a generic hook on the first slide", async () => {
    const score = await prepublishScoreFor({
      workspaceId,
      variant: variant(),
      item,
      channel,
      offer: null,
      now,
    });
    expect(score.verdict).toBe("block");
  });
  it("blocks a stale price claim and uses the policy window", async () => {
    const clean = { ...item, creativeSlides: [] } as unknown as ContentItem;
    const stale = await prepublishScoreFor({
      workspaceId,
      variant: variant(),
      item: clean,
      channel,
      offer: offer("2026-08-01T00:00:00Z"),
      now,
    });
    expect(stale.verdict).toBe("block");
    const allowed = await prepublishScoreFor({
      workspaceId,
      variant: variant(),
      item: clean,
      channel,
      offer: offer("2026-08-01T00:00:00Z"),
      policy: { evidenceMaxAgeDays: 90 },
      now,
    });
    expect(allowed.verdict).toBe("pass");
  });

  it("blocks copy whose claims the offer facts do not back, and names them", async () => {
    const clean = { ...item, creativeSlides: [] } as unknown as ContentItem;
    const fresh = offer("2026-09-29T00:00:00Z");
    const score = (caption: string) =>
      prepublishScoreFor({
        workspaceId,
        variant: { ...variant(), caption } as ContentVariant,
        item: clean,
        channel,
        offer: fresh,
        now,
      });
    const bad = await score("Cesto prático. Testei e aprovei!");
    expect(bad.verdict).toBe("block");
    expect(bad.checks.find((check) => check.id === "claims_backed")).toMatchObject({
      result: "fail",
      detail: "testimonial:Testei e aprovei!",
    });
    const good = await score("Cesto prático para a lavanderia.");
    expect(good.checks.find((check) => check.id === "claims_backed")?.result).toBe("pass");
    const dated = await score("Cesto prático. Preço em 28/09 (o preço muda). Frete não incluso.");
    expect(dated.verdict).toBe("block");
    expect(dated.checks.find((check) => check.id === "claims_backed")?.detail).toMatch(
      /^copy_price_date:/,
    );
  });

  describe("I1 price shown inference", () => {
    const clean = { ...item, creativeSlides: [] } as unknown as ContentItem;
    const stale = offer("2026-08-01T00:00:00Z");
    const score = (v: ContentVariant, o: Offer | null = stale, i = clean) =>
      prepublishScoreFor({ workspaceId, variant: v, item: i, channel, offer: o, now });
    it("treats a variant with an offer snapshot as showing the price by default", async () => {
      const v = { ...variant(), creativeFeatures: {} } as unknown as ContentVariant;
      expect((await score(v)).verdict).toBe("block");
    });
    it("respects an explicit priceShown=false", async () => {
      const v = {
        ...variant(),
        creativeFeatures: { priceShown: false, discountShown: false },
      } as unknown as ContentVariant;
      expect((await score(v)).verdict).toBe("pass");
    });
    it("detects a price in the caption even when priceShown=false", async () => {
      const v = {
        ...variant(),
        caption: "Só R$ 49",
        creativeFeatures: { priceShown: false, discountShown: false },
      } as unknown as ContentVariant;
      expect((await score(v)).verdict).toBe("block");
    });
    it("detects a price in slide text", async () => {
      const v = {
        ...variant(),
        creativeFeatures: { priceShown: false, discountShown: false },
      } as unknown as ContentVariant;
      const slides = {
        ...item,
        creativeSlides: [
          { index: 0, total: 1, template: "hero", headline: "Olhe R$99", claims: [] },
        ],
      } as unknown as ContentItem;
      expect((await score(v, stale, slides)).verdict).toBe("block");
    });
  });

  it("I11 checks both the slide headline and the first voice line for a generic hook", async () => {
    const v = {
      ...variant({ priceShown: false }),
      voiceScript: ["Imperdível esta oferta"],
    } as unknown as ContentVariant;
    const fine = {
      ...item,
      creativeSlides: [
        { index: 0, total: 1, template: "hero", headline: "Fila some em 5 min", claims: [] },
      ],
    } as unknown as ContentItem;
    const score = await prepublishScoreFor({
      workspaceId,
      variant: v,
      item: fine,
      channel,
      offer: null,
      now,
    });
    expect(score.verdict).toBe("block");
  });
});
