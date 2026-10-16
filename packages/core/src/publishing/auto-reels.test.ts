import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../channels/channel.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import { uuidFromKey } from "../content/offer-package.js";
import type { Offer } from "../offers/offer.js";
import {
  type AutoReelDeps,
  attachAutoReelAsset,
  autoReelVoiceScript,
  requestAutoReels,
} from "./auto-reels.js";
import type { ReelRender, ReelRenderRepository } from "./reel-render.js";

const workspaceId = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const offer = {
  id: "offer-1",
  workspaceId,
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [{ id: "s1", verifiedAt: new Date(), facts: [] }],
} as unknown as Offer;
const slide = (index: number, headline: string, body?: string) => ({
  index,
  total: 2,
  template: "benefit" as const,
  headline,
  ...(body ? { body } : {}),
  claims: [],
});
const item = {
  id: uuidFromKey("auto-sale:offer-1"),
  workspaceId,
  nicheId: "n1",
  offerId: "offer-1",
  offerSnapshotId: "s1",
  title: "Auto",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
  creativeSlides: [slide(1, "Gancho", "Detalhe"), slide(2, "Fecho")],
} as unknown as ContentItem;
const channel = (id: string, kind: string, status = "active", nicheId: string | null = "n1") =>
  ({
    id,
    workspaceId,
    nicheId,
    kind,
    status,
    capabilities: { captionMaxLength: 2200, maxAssets: 10, allowedMimeTypes: [] },
  }) as unknown as Channel;
const carousel = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId,
  contentItemId: item.id,
  channelId: "c-car",
  offerSnapshotId: "s1",
  assetIds: ["a1", "a2"],
  caption: "Legenda #publi",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
  creativeRender: { state: "rendered" },
} as unknown as ContentVariant;

const setup = (
  overrides: { item?: ContentItem; channels?: Channel[]; variants?: ContentVariant[] } = {},
) => {
  const variants = [...(overrides.variants ?? [carousel])];
  const renders = {
    createPending: vi.fn(async () => ({
      created: true,
      render: { attempt: 1, status: "pending", updatedAt: new Date() } as ReelRender,
    })),
  } as unknown as ReelRenderRepository;
  const jobs = { enqueue: vi.fn(async () => ({ id: "j" })) };
  const deps = {
    content: {
      findContentItemForWorkspace: async () => overrides.item ?? item,
      listVariantsForWorkspace: async () => variants,
      createVariant: vi.fn(async (v: ContentVariant) => (variants.push(v), v)),
      updateVariant: vi.fn(async (v: ContentVariant) => v),
    },
    channels: {
      findForWorkspace: async () => null,
      listForWorkspace: async () =>
        overrides.channels ?? [
          channel("c-car", "instagram_carousel"),
          channel("c-reel", "instagram_reels"),
          channel("c-tt", "tiktok_video"),
        ],
    },
    offers: { findForWorkspace: async () => offer },
    renders,
    jobs,
    newId: () => "r1",
  } as unknown as AutoReelDeps & {
    content: { createVariant: ReturnType<typeof vi.fn>; updateVariant: ReturnType<typeof vi.fn> };
  };
  return { deps, variants, jobs, renders };
};

describe("autoReelVoiceScript", () => {
  it("joins headline and body, falling back to the headline when too long", () => {
    expect(autoReelVoiceScript([slide(1, "A", "B"), slide(2, "C", "x".repeat(300))])).toEqual([
      "A. B",
      "C",
    ]);
  });
  it("speaks the plan's voice line when it passes the script rules", () => {
    expect(
      autoReelVoiceScript([
        { ...slide(1, "A", "B"), voiceLine: " Olha só o que cabe aqui. " },
        { ...slide(2, "C"), voiceLine: "#tag" },
        { ...slide(3, "D"), voiceLine: "" },
      ]),
    ).toEqual(["Olha só o que cabe aqui.", "C", "D"]);
  });
});

describe("requestAutoReels", () => {
  it("uses only the reel channels of the item's niche profile", async () => {
    const { deps, variants } = setup({
      channels: [
        channel("c-car", "instagram_carousel"),
        channel("c-reel", "instagram_reels"),
        channel("other-reel", "instagram_reels", "active", "n2"),
        channel("unbound-tt", "tiktok_video", "active", null),
      ],
    });
    await requestAutoReels(deps, { workspaceId, contentItemId: item.id });
    expect(variants.filter((v) => v.channelId !== "c-car").map((v) => v.channelId)).toEqual([
      "c-reel",
    ]);
  });

  it("creates one draft variant per active reel channel and enqueues one render from the draft carousel", async () => {
    const { deps, variants, jobs, renders } = setup();
    expect(await requestAutoReels(deps, { workspaceId, contentItemId: item.id })).toBe("requested");
    expect(
      variants
        .filter((v) => v.channelId !== "c-car")
        .map((v) => [v.channelId, v.state, v.assetIds]),
    ).toEqual([
      ["c-reel", "draft", []],
      ["c-tt", "draft", []],
    ]);
    expect(deps.content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "44444444-4444-4444-8444-444444444444",
        voiceScript: ["Gancho. Detalhe", "Fecho"],
      }),
    );
    expect(renders.createPending).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate reel variants when it runs again", async () => {
    const { deps, variants } = setup();
    await requestAutoReels(deps, { workspaceId, contentItemId: item.id });
    await requestAutoReels(deps, { workspaceId, contentItemId: item.id });
    expect(variants).toHaveLength(3);
  });

  it("skips non-auto items, missing reel channels and unrendered carousels", async () => {
    const manual = { ...item, id: "33333333-3333-4333-8333-333333333333" } as ContentItem;
    expect(
      await requestAutoReels(setup({ item: manual }).deps, {
        workspaceId,
        contentItemId: manual.id,
      }),
    ).toBe("skipped");
    const noReels = setup({ channels: [channel("c-car", "instagram_carousel")] });
    expect(await requestAutoReels(noReels.deps, { workspaceId, contentItemId: item.id })).toBe(
      "skipped",
    );
    const pending = setup({
      variants: [{ ...carousel, creativeRender: { state: "pending" } } as ContentVariant],
    });
    expect(await requestAutoReels(pending.deps, { workspaceId, contentItemId: item.id })).toBe(
      "skipped",
    );
    expect(pending.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("never renders from an approved-out-of-queue state it did not expect (cancelled carousel)", async () => {
    const { deps, jobs } = setup({
      variants: [{ ...carousel, state: "cancelled" } as ContentVariant],
    });
    expect(await requestAutoReels(deps, { workspaceId, contentItemId: item.id })).toBe("skipped");
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("attachAutoReelAsset", () => {
  it("fills only the empty draft reel variants", async () => {
    const reel = { ...carousel, id: "v-reel", channelId: "c-reel", assetIds: [] } as ContentVariant;
    const done = { ...carousel, id: "v-tt", channelId: "c-tt", assetIds: ["x"] } as ContentVariant;
    const { deps } = setup({ variants: [carousel, reel, done] });
    await attachAutoReelAsset(deps, { workspaceId, source: carousel, assetId: "video" });
    expect(deps.content.updateVariant).toHaveBeenCalledTimes(1);
    expect(deps.content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({ id: "v-reel", assetIds: ["video"], state: "draft" }),
    );
  });
});
