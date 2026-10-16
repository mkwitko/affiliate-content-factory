import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { Offer } from "@money-maker/core/offers/offer";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { buildPostCreativesTool } from "./build-post-creatives.js";

const actorId = parseUserId("11111111-1111-4111-8111-111111111111");
const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const contentItemId = "33333333-3333-4333-8333-333333333333";
const offer: Offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
  affiliateUrl: "https://meli.la/abc",
  title: "Product",
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
};
const item: ContentItem = {
  id: contentItemId,
  workspaceId,
  nicheId: "niche-1",
  offerId: offer.id,
  offerSnapshotId: "snapshot-1",
  title: "Product",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "Useful",
  state: "draft",
};
const channel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel",
  label: "Instagram",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/png"],
    captionMaxLength: 2200,
  },
};
const slides = Array.from({ length: 5 }, (_, index) => ({
  index: index + 1,
  total: 5,
  template: index === 0 ? ("hero" as const) : ("benefit" as const),
  headline: index === 0 ? "R$ 100" : `Benefit ${index + 1}`,
  claims: index === 0 ? [{ text: "R$ 100", factKey: "current_price" }] : [],
}));

const dependencies = () => {
  const variants: ContentVariant[] = [];
  const contentRepository = {
    findContentItemForWorkspace: vi.fn(async () => item),
    updateContentItem: vi.fn(async (value: ContentItem) => value),
    createVariant: vi.fn(async (value: ContentVariant) => {
      variants.push(value);
      return value;
    }),
  };
  const jobQueue = { enqueue: vi.fn(async () => ({ id: "job-1" })) };
  const deps = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "operator" as const,
        status: "active" as const,
      }),
    },
    contentRepository,
    offerRepository: { findForWorkspace: async () => offer },
    channelRepository: { findForWorkspace: async () => channel },
    jobQueue,
  } as unknown as McpDependencies;
  return { deps, contentRepository, jobQueue, variants };
};

describe("build_post_creatives MCP tool", () => {
  it("creates pending channel variants, stores slides, and enqueues the render", async () => {
    const { deps, contentRepository, jobQueue, variants } = dependencies();
    const result = await buildPostCreativesTool(
      { workspaceId, contentItemId, slides, channelIds: [channel.id] },
      actorId,
      deps,
    );

    expect(result).toEqual({
      ok: true,
      value: { jobId: "job-1", variantIds: { [channel.id]: variants[0]?.id } },
    });
    expect(contentRepository.updateContentItem).toHaveBeenCalledWith(
      expect.objectContaining({ creativeSlides: slides }),
    );
    expect(variants[0]).toMatchObject({ assetIds: [], creativeRender: { state: "pending" } });
    expect(jobQueue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "render_creatives",
        idempotencyKey: `creative-render:${contentItemId}:1`,
      }),
    );
  });

  it("stores an optional sceneAssetId and rejects a malformed one", async () => {
    const sceneAssetId = "44444444-4444-4444-8444-444444444444";
    const withScene = slides.map((slide) => ({ ...slide, sceneAssetId }));
    const { deps, contentRepository } = dependencies();
    const ok = await buildPostCreativesTool(
      { workspaceId, contentItemId, slides: withScene, channelIds: [channel.id] },
      actorId,
      deps,
    );
    expect(ok.ok).toBe(true);
    expect(contentRepository.updateContentItem).toHaveBeenCalledWith(
      expect.objectContaining({ creativeSlides: withScene }),
    );
    const bad = await buildPostCreativesTool(
      {
        workspaceId,
        contentItemId,
        slides: slides.map((slide) => ({ ...slide, sceneAssetId: "../etc" })),
        channelIds: [channel.id],
      },
      actorId,
      dependencies().deps,
    );
    expect(bad).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects numerical slide claims with no matching offer fact", async () => {
    const { deps } = dependencies();
    const unsupported = slides.map((slide, index) =>
      index === 0 ? { ...slide, headline: "R$ 99" } : slide,
    );
    expect(
      await buildPostCreativesTool(
        { workspaceId, contentItemId, slides: unsupported, channelIds: [channel.id] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "CLAIM_WITHOUT_EVIDENCE:R$ 99" });
  });

  it.each([
    [{ headline: "Testei e aprovei" }, "Testei e aprovei"],
    [{ claims: [{ text: "Super resistente", factKey: "current_price" }] }, "Super resistente"],
  ])("rejects invented or mismatched claims %j", async (over, text) => {
    const { deps } = dependencies();
    const unsupported = slides.map((slide, index) => (index === 0 ? { ...slide, ...over } : slide));
    expect(
      await buildPostCreativesTool(
        { workspaceId, contentItemId, slides: unsupported, channelIds: [channel.id] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: `CLAIM_WITHOUT_EVIDENCE:${text}` });
  });

  it("rejects a generic opening before creating variants or queueing paid generation", async () => {
    const { deps, contentRepository, jobQueue } = dependencies();
    const lowQuality = slides.map((slide, index) =>
      index === 0 ? { ...slide, headline: "Você não vai acreditar" } : slide,
    );

    expect(
      await buildPostCreativesTool(
        { workspaceId, contentItemId, slides: lowQuality, channelIds: [channel.id] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "CREATIVE_QUALITY_REJECTED:generic_hook" });
    expect(contentRepository.updateContentItem).not.toHaveBeenCalled();
    expect(contentRepository.createVariant).not.toHaveBeenCalled();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects repeated slide copy before queueing generation", async () => {
    const { deps, contentRepository, jobQueue } = dependencies();
    const repetitive = slides.map((slide, index) =>
      index === 0 ? slide : { ...slide, headline: "A dica que resolve seu espaço" },
    );

    expect(
      await buildPostCreativesTool(
        { workspaceId, contentItemId, slides: repetitive, channelIds: [channel.id] },
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "CREATIVE_QUALITY_REJECTED:repeated_slide_copy" });
    expect(contentRepository.updateContentItem).not.toHaveBeenCalled();
    expect(contentRepository.createVariant).not.toHaveBeenCalled();
    expect(jobQueue.enqueue).not.toHaveBeenCalled();
  });

  it("rejects an inactive offer", async () => {
    const { deps } = dependencies();
    const withInactiveOffer = {
      ...deps,
      offerRepository: { findForWorkspace: async () => ({ ...offer, state: "draft" as const }) },
    } as unknown as McpDependencies;
    expect(
      await buildPostCreativesTool(
        { workspaceId, contentItemId, slides, channelIds: [channel.id] },
        actorId,
        withInactiveOffer,
      ),
    ).toEqual({ ok: false, error: "OFFER_NOT_ACTIVE" });
  });
});
