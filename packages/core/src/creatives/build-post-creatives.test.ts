import { describe, expect, it, vi } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "../channels/channel.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import type { Offer } from "../offers/offer.js";
import { buildPostCreatives, type BuildPostCreativesDeps } from "./build-post-creatives.js";

const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const offer = {
  id: "offer-1",
  workspaceId,
  state: "active",
  activeSnapshotId: "snapshot-1",
  snapshots: [
    {
      id: "snapshot-1",
      verifiedAt: new Date("2026-09-25T12:00:00.000Z"),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 10000, currency: "BRL" },
          sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
          verified: true,
        },
      ],
    },
  ],
} as unknown as Offer;
const item = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId,
  nicheId: "niche-1",
  offerId: "offer-1",
  offerSnapshotId: "snapshot-1",
  title: "Product",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "Useful",
  state: "draft",
} as unknown as ContentItem;
const channel = (id: string) =>
  ({ id, workspaceId, kind: "instagram_carousel", status: "active" }) as unknown as Channel;
const slides = Array.from({ length: 5 }, (_, index) => ({
  index: index + 1,
  total: 5,
  template: index === 0 ? ("hero" as const) : ("benefit" as const),
  headline: index === 0 ? "R$ 100" : `Benefit ${index + 1}`,
  claims: index === 0 ? [{ text: "R$ 100", factKey: "current_price" }] : [],
}));

const setup = () => {
  const variants: ContentVariant[] = [];
  const deps = {
    contentRepository: {
      findContentItemForWorkspace: async () => item,
      updateContentItem: vi.fn(async (v: ContentItem) => v),
      createVariant: async (v: ContentVariant) => (variants.push(v), v),
    },
    offerRepository: { findForWorkspace: async () => offer },
    channelRepository: {
      findForWorkspace: async ({ channelId }: { channelId: string }) => channel(channelId),
    },
    jobQueue: { enqueue: vi.fn(async () => ({ id: "job-1" })) },
  } as unknown as BuildPostCreativesDeps;
  return { deps, variants };
};
const input = { workspaceId, contentItemId: item.id, slides, channelIds: ["c1", "c2"] };

describe("buildPostCreatives", () => {
  it("writes per-channel captions and keeps the placeholder otherwise", async () => {
    const { deps, variants } = setup();
    const result = await buildPostCreatives(deps, {
      ...input,
      captions: { c1: "Preço de R$ 100 hoje" },
    });
    expect(result.ok).toBe(true);
    expect(variants.map((v) => v.caption)).toEqual(["Preço de R$ 100 hoje", "Caption pending."]);
  });

  it("stores derived creative features on every new variant", async () => {
    const { deps, variants } = setup();
    await buildPostCreatives(deps, input);
    expect(variants.map((v) => v.creativeFeatures)).toEqual([
      expect.objectContaining({ format: "carousel", priceShown: false, ratingShown: false }),
      expect.objectContaining({ format: "carousel", priceShown: false, ratingShown: false }),
    ]);
  });

  it("rejects a caption number without evidence before creating anything", async () => {
    const { deps, variants } = setup();
    const result = await buildPostCreatives(deps, { ...input, captions: { c1: "Só R$ 37" } });
    expect(result).toMatchObject({ ok: false });
    expect(variants).toHaveLength(0);
  });

  it("rejects duplicate channels", async () => {
    const { deps } = setup();
    expect(await buildPostCreatives(deps, { ...input, channelIds: ["c1", "c1"] })).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
});
