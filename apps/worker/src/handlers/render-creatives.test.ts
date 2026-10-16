import { parseWorkspaceId } from "@money-maker/contracts";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import type { RenderCreativesDeps } from "@money-maker/core/creatives/render-creatives";
import { renderCreatives } from "@money-maker/core/creatives/render-creatives";
import { describe, expect, it, vi } from "vitest";
import { assertRendererReady, createRenderCreativesHandler } from "./render-creatives.js";

vi.mock("@money-maker/core/creatives/render-creatives", () => ({ renderCreatives: vi.fn() }));

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const item: ContentItem = {
  id: "22222222-2222-4222-8222-222222222222",
  workspaceId,
  nicheId: "niche-1",
  offerId: "offer-1",
  offerSnapshotId: "snapshot-1",
  title: "Product",
  sourceFactKeys: [],
  creativeSlides: [{ index: 1, total: 1, template: "hero", headline: "Product", claims: [] }],
  creativeOpinion: "Useful",
  state: "draft",
};
const variant: ContentVariant = {
  id: "variant-1",
  workspaceId,
  contentItemId: item.id,
  channelId: "channel-1",
  offerSnapshotId: "snapshot-1",
  assetIds: [],
  caption: "Caption",
  language: "pt-BR",
  state: "draft",
  voiceScript: [],
};
const deps = () => {
  const content = {
    findContentItemForWorkspace: vi.fn(async () => item),
    listVariantsForWorkspace: vi.fn(async () => [variant]),
    updateVariant: vi.fn(async (input: ContentVariant) => input),
  };
  const channels = {
    findForWorkspace: vi.fn(async () => ({
      id: variant.channelId,
      workspaceId,
      kind: "instagram_carousel" as const,
      status: "active" as const,
    })),
  };
  return {
    content,
    channels,
    handler: createRenderCreativesHandler({ content, channels } as unknown as RenderCreativesDeps),
  };
};
const job = {
  payload: {
    version: 1 as const,
    workspaceId,
    identifiers: { contentItemId: item.id },
  },
};

describe("assertRendererReady", () => {
  it("fails startup when bundled fonts are missing", async () => {
    await expect(
      assertRendererReady({
        assertFontsPresent: () => {
          throw new Error("font_missing:x");
        },
        renderSelfCheck: async () => new Uint8Array(),
        verifyOutput: async () => true,
      }),
    ).rejects.toThrow("font_missing:x");
  });
  it("rejects a renderer output that fails verification", async () => {
    await expect(
      assertRendererReady({
        assertFontsPresent: vi.fn(),
        renderSelfCheck: async () => new Uint8Array([1]),
        verifyOutput: async () => false,
      }),
    ).rejects.toThrow("renderer_self_check_failed");
  });
  it("accepts a renderer output that passes verification", async () => {
    await expect(
      assertRendererReady({
        assertFontsPresent: vi.fn(),
        renderSelfCheck: async () => new Uint8Array([1]),
        verifyOutput: async () => true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("createRenderCreativesHandler", () => {
  it("records permanent render failures on every variant", async () => {
    vi.mocked(renderCreatives).mockResolvedValue({
      status: "renderer_failure",
      reason: "layout_failed",
    });
    const { content, handler } = deps();

    await expect(handler(job)).rejects.toMatchObject({ reason: "layout_failed" });
    expect(content.updateVariant).toHaveBeenCalledWith(
      expect.objectContaining({
        creativeRender: expect.objectContaining({ state: "failed", reason: "layout_failed" }),
      }),
    );
  });

  it("passes the persisted slides and selected channel to the renderer", async () => {
    vi.mocked(renderCreatives).mockResolvedValue({
      status: "rendered",
      assetIdsByChannel: { [variant.channelId]: ["asset-1"] },
      fallbacks: [],
    });
    const { handler } = deps();

    await handler(job);
    expect(renderCreatives).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId,
        contentItemId: item.id,
        slides: item.creativeSlides,
        channels: [{ channelId: variant.channelId, kind: "instagram_carousel", canvas: "feed" }],
      }),
    );
  });

  it("skips a tiktok_video variant instead of trying to slide-render it", async () => {
    vi.mocked(renderCreatives).mockResolvedValue({
      status: "rendered",
      assetIdsByChannel: { [variant.channelId]: ["asset-1"] },
      fallbacks: [],
    });
    const tiktokVariant: ContentVariant = { ...variant, id: "variant-2", channelId: "channel-2" };
    const content = {
      findContentItemForWorkspace: vi.fn(async () => item),
      listVariantsForWorkspace: vi.fn(async () => [variant, tiktokVariant]),
      updateVariant: vi.fn(async (input: ContentVariant) => input),
    };
    const channels = {
      findForWorkspace: vi.fn(async ({ channelId }: { channelId: string }) => ({
        id: channelId,
        workspaceId,
        kind:
          channelId === "channel-2" ? ("tiktok_video" as const) : ("instagram_carousel" as const),
        status: "active" as const,
      })),
    };
    const handler = createRenderCreativesHandler({
      content,
      channels,
    } as unknown as RenderCreativesDeps);

    await handler(job);
    expect(renderCreatives).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channels: [{ channelId: variant.channelId, kind: "instagram_carousel", canvas: "feed" }],
      }),
    );
  });
});
