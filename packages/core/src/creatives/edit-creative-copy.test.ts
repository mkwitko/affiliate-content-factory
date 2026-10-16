import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../channels/channel.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import type { Offer } from "../offers/offer.js";
import { type EditCreativeCopyDeps, editCreativeCopy } from "./edit-creative-copy.js";

const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const offer = {
  id: "offer-1",
  workspaceId,
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [
    {
      id: "s1",
      verifiedAt: new Date(),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 10000, currency: "BRL" },
          sourceUrl: "https://x",
          verified: true,
        },
      ],
    },
  ],
} as unknown as Offer;
const scene = "44444444-4444-4444-8444-444444444444";
const slides = Array.from({ length: 5 }, (_, i) => ({
  index: i + 1,
  total: 5,
  template: "benefit" as const,
  headline: `Beneficio ${i + 1}`,
  body: `Corpo ${i + 1}`,
  badge: i === 0 ? "R$ 100" : undefined,
  sceneAssetId: scene,
  storySceneAssetId: scene,
  claims: [],
}));
const item = {
  id: "33333333-3333-4333-8333-333333333333",
  workspaceId,
  nicheId: "n",
  offerId: "offer-1",
  offerSnapshotId: "s1",
  title: "t",
  sourceFactKeys: ["current_price"],
  creativeOpinion: "x",
  state: "draft",
  creativeSlides: slides,
} as unknown as ContentItem;
const channels: Record<string, Channel> = {
  car: {
    id: "car",
    workspaceId,
    kind: "instagram_carousel",
    status: "active",
    capabilities: { captionMaxLength: 2200 },
  } as unknown as Channel,
  reel: {
    id: "reel",
    workspaceId,
    kind: "instagram_reels",
    status: "active",
    capabilities: { captionMaxLength: 2200 },
  } as unknown as Channel,
};
const variant = (id: string, channelId: string, state: string, assetIds: string[] = []) =>
  ({
    id,
    workspaceId,
    contentItemId: item.id,
    channelId,
    assetIds,
    caption: "Legenda\n\n#publi",
    state,
    creativeRender: { state: "rendered" },
    voiceScript: [],
  }) as unknown as ContentVariant;

const setup = (variants: ContentVariant[], foundItem: ContentItem | null = item) => {
  const deps = {
    content: {
      findContentItemForWorkspace: vi.fn(async () => foundItem),
      updateContentItem: vi.fn(async (v: ContentItem) => v),
      listVariantsForWorkspace: vi.fn(async () => variants),
      updateVariant: vi.fn(async (v: ContentVariant) => v),
    },
    offers: { findForWorkspace: async () => offer },
    channels: {
      findForWorkspace: async ({ channelId }: { channelId: string }) => channels[channelId] ?? null,
    },
    jobs: { enqueue: vi.fn(async () => ({ id: "j" })) },
    reels: { invalidateReady: vi.fn(async () => undefined) },
    now: () => new Date(1_000),
  } as unknown as EditCreativeCopyDeps & {
    content: {
      updateContentItem: ReturnType<typeof vi.fn>;
      updateVariant: ReturnType<typeof vi.fn>;
    };
    jobs: { enqueue: ReturnType<typeof vi.fn> };
    reels: { invalidateReady: ReturnType<typeof vi.fn> };
  };
  return deps;
};
const base = { workspaceId, contentItemId: item.id };

describe("editCreativeCopy", () => {
  it("edits a headline, keeps scenes and badge, and queues one re-render", async () => {
    const deps = setup([variant("v1", "car", "ready_for_review", ["a"])]);
    const result = await editCreativeCopy(deps, {
      ...base,
      slides: [{ index: 2, headline: "Novo titulo" }],
    });
    expect(result).toMatchObject({
      ok: true,
      value: { slidesChanged: true, rerenderQueued: true },
    });
    const saved = deps.content.updateContentItem.mock.calls[0]?.[0] as ContentItem;
    expect(saved.creativeSlides?.[1]).toMatchObject({
      headline: "Novo titulo",
      body: "Corpo 2",
      sceneAssetId: scene,
      storySceneAssetId: scene,
    });
    expect(saved.creativeSlides?.[0]?.badge).toBe("R$ 100");
    expect(deps.jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ name: "render_creatives" }),
    );
    expect(deps.reels.invalidateReady).toHaveBeenCalledWith(
      expect.objectContaining({ sourceVariantId: "v1" }),
    );
    expect(deps.content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "v1",
        creativeRender: expect.objectContaining({ state: "pending" }),
      }),
    );
  });

  it("drops a stale reel video and reports it", async () => {
    const deps = setup([
      variant("v1", "car", "draft", ["a"]),
      variant("v2", "reel", "draft", ["video"]),
    ]);
    const result = await editCreativeCopy(deps, {
      ...base,
      slides: [{ index: 1, body: "Outro corpo" }],
    });
    expect(result).toMatchObject({ ok: true, value: { reelsStale: true } });
    expect(deps.content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({ id: "v2", assetIds: [] }),
    );
    expect(deps.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects numbers without evidence, links and unknown slides", async () => {
    const deps = setup([variant("v1", "car", "draft")]);
    expect(
      await editCreativeCopy(deps, { ...base, slides: [{ index: 2, headline: "So R$ 37" }] }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("CLAIM_WITHOUT_EVIDENCE"),
    });
    expect(
      await editCreativeCopy(deps, { ...base, slides: [{ index: 2, body: "veja loja.com.br" }] }),
    ).toEqual({
      ok: false,
      error: "COPY_REJECTED:copy_link_not_allowed",
    });
    expect(
      await editCreativeCopy(deps, { ...base, slides: [{ index: 9, headline: "x" }] }),
    ).toEqual({
      ok: false,
      error: "SLIDE_NOT_FOUND",
    });
    expect(
      await editCreativeCopy(deps, {
        ...base,
        slides: [
          { index: 2, headline: "Confira isso" },
          { index: 1, headline: "Confira isso" },
        ],
      }),
    ).toMatchObject({ ok: false });
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
    expect(deps.content.updateContentItem).not.toHaveBeenCalled();
  });

  it("refuses slide edits when any variant is approved, and caption edits on a non-editable variant", async () => {
    const deps = setup([variant("v1", "car", "approved"), variant("v2", "reel", "draft")]);
    expect(
      await editCreativeCopy(deps, { ...base, slides: [{ index: 1, headline: "Novo" }] }),
    ).toEqual({
      ok: false,
      error: "CONTENT_ALREADY_APPROVED",
    });
    expect(
      await editCreativeCopy(deps, { ...base, captions: [{ variantId: "v1", caption: "Nova" }] }),
    ).toEqual({
      ok: false,
      error: "VARIANT_NOT_EDITABLE",
    });
    expect(deps.content.updateVariant).not.toHaveBeenCalled();
  });

  it("appends CTA and disclosure to a caption and rejects hashtags", async () => {
    const deps = setup([variant("v1", "car", "draft")]);
    const ok = await editCreativeCopy(deps, {
      ...base,
      captions: [{ variantId: "v1", caption: "Texto novo\n\n#publi\n🔗 Link na bio" }],
    });
    expect(ok).toMatchObject({ ok: true, value: { slidesChanged: false, rerenderQueued: false } });
    expect(deps.content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({ caption: "Texto novo\n\n🔗 Link na bio\n\n#publi" }),
    );
    expect(
      await editCreativeCopy(deps, {
        ...base,
        captions: [{ variantId: "v1", caption: "x #promo" }],
      }),
    ).toEqual({
      ok: false,
      error: "COPY_REJECTED:caption_hashtags",
    });
    expect(deps.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("returns not found for another workspace's item and needs something to edit", async () => {
    expect(
      await editCreativeCopy(setup([], null), { ...base, slides: [{ index: 1, headline: "x" }] }),
    ).toEqual({
      ok: false,
      error: "CONTENT_NOT_FOUND",
    });
    expect(await editCreativeCopy(setup([]), base)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
});
