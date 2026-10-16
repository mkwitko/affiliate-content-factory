import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelRepository } from "../channels/channel-repository.js";
import { type ContentVariant, createVariant, voiceScriptItemProblem } from "../content/content.js";
import type { ContentRepository } from "../content/content-repository.js";
import { isAutoSaleItem } from "../content/offer-package.js";
import type { SlideSpec } from "../creatives/slide-spec.js";
import type { JobQueue } from "../jobs/job.js";
import type { OfferRepository } from "../offers/offer-repository.js";
import { type ReelRenderRepository, requestReelRender } from "./reel-render.js";

const reelKinds: readonly string[] = ["instagram_reels", "tiktok_video"];
const liveStates: readonly ContentVariant["state"][] = ["draft", "ready_for_review"];

export type AutoReelDeps = Readonly<{
  content: Pick<
    ContentRepository,
    "findContentItemForWorkspace" | "listVariantsForWorkspace" | "createVariant" | "updateVariant"
  >;
  channels: Pick<ChannelRepository, "findForWorkspace" | "listForWorkspace">;
  offers: Pick<OfferRepository, "findForWorkspace">;
  renders: ReelRenderRepository;
  jobs: Pick<JobQueue, "enqueue">;
  newId: () => string;
}>;

/**
 * One spoken item per slide: the plan's voice line (written for the ear by the copy model) when
 * it passes the script rules, else the headline plus the body when the pair fits the limit.
 */
export const autoReelVoiceScript = (slides: readonly SlideSpec[]): readonly string[] =>
  slides.map((slide) => {
    const voice = slide.voiceLine?.trim();
    if (voice && voiceScriptItemProblem(voice) === null) return voice;
    const both = `${slide.headline.trim()}. ${(slide.body ?? "").trim()}`.replace(/\.\s*$/, "");
    return slide.body && voiceScriptItemProblem(both) === null ? both : slide.headline.trim();
  });

/**
 * After an auto package renders: its carousel variant narrates the slide copy and renders one
 * Reel (idempotent per carousel variant); every active Reels / TikTok video channel gets one draft
 * variant that receives the video when it is ready. Nothing is approved or published here.
 */
export const requestAutoReels = async (
  deps: AutoReelDeps,
  input: Readonly<{ workspaceId: WorkspaceId; contentItemId: string }>,
): Promise<"skipped" | "requested"> => {
  const { workspaceId } = input;
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: input.contentItemId,
  });
  if (!item?.offerId || !isAutoSaleItem(item) || !item.creativeSlides?.length) return "skipped";
  const channels = await deps.channels.listForWorkspace?.(workspaceId);
  if (!channels) return "skipped";
  const reelChannels = channels.filter(
    (channel) =>
      channel.status === "active" &&
      channel.nicheId === item.nicheId &&
      reelKinds.includes(channel.kind),
  );
  if (reelChannels.length === 0) return "skipped";
  const variants = (await deps.content.listVariantsForWorkspace(workspaceId)).filter(
    (variant) => variant.contentItemId === item.id,
  );
  const carousel = variants.find(
    (variant) =>
      liveStates.includes(variant.state) &&
      variant.creativeRender?.state === "rendered" &&
      variant.assetIds.length === item.creativeSlides?.length &&
      channels.some(
        (channel) => channel.id === variant.channelId && channel.kind === "instagram_carousel",
      ),
  );
  const carouselChannel = channels.find((channel) => channel.id === carousel?.channelId);
  if (!carousel || !carouselChannel) return "skipped";
  const offer = await deps.offers.findForWorkspace({ workspaceId, offerId: item.offerId });
  if (!offer) return "skipped";

  const voiceScript = autoReelVoiceScript(item.creativeSlides);
  const source = { ...carousel, voiceScript };
  if (carousel.voiceScript.join("\n") !== voiceScript.join("\n"))
    await deps.content.updateVariant(source);
  for (const channel of reelChannels) {
    const exists = variants.some(
      (variant) => variant.channelId === channel.id && variant.state !== "cancelled",
    );
    if (exists) continue;
    await deps.content.createVariant(
      createVariant({
        workspaceId,
        contentItem: item,
        channel,
        offer,
        assetIds: [],
        caption: carousel.caption.slice(0, channel.capabilities.captionMaxLength),
        language: carousel.language,
      }),
    );
  }
  await requestReelRender({
    workspaceId,
    variant: source,
    channel: carouselChannel,
    renders: deps.renders,
    jobs: deps.jobs,
    renderId: deps.newId(),
    voiceMode: "script",
    allowDraftSource: true,
  });
  return "requested";
};

/** Channel kinds of the item's live Reels / TikTok video drafts still waiting for a video. */
export const autoReelKindsAwaiting = async (
  deps: Pick<AutoReelDeps, "content" | "channels">,
  input: Readonly<{ workspaceId: WorkspaceId; source: ContentVariant }>,
): Promise<ReadonlySet<string>> => {
  const channels = (await deps.channels.listForWorkspace?.(input.workspaceId)) ?? [];
  const kinds = new Set<string>();
  for (const variant of await deps.content.listVariantsForWorkspace(input.workspaceId)) {
    if (
      variant.contentItemId !== input.source.contentItemId ||
      !liveStates.includes(variant.state) ||
      variant.assetIds.length > 0
    )
      continue;
    const kind = channels.find((channel) => channel.id === variant.channelId)?.kind;
    if (kind && reelKinds.includes(kind)) kinds.add(kind);
  }
  return kinds;
};

/**
 * The finished Reel becomes the video of the item's still-empty Reels / TikTok video drafts;
 * with `kinds`, only drafts of those channel kinds (a TikTok edition with other music).
 */
export const attachAutoReelAsset = async (
  deps: Pick<AutoReelDeps, "content" | "channels">,
  input: Readonly<{
    workspaceId: WorkspaceId;
    source: ContentVariant;
    assetId: string;
    kinds?: readonly string[];
  }>,
): Promise<void> => {
  const { workspaceId, source } = input;
  const item = await deps.content.findContentItemForWorkspace({
    workspaceId,
    contentItemId: source.contentItemId,
  });
  if (!item || !isAutoSaleItem(item)) return;
  const channels = (await deps.channels.listForWorkspace?.(workspaceId)) ?? [];
  const variants = await deps.content.listVariantsForWorkspace(workspaceId);
  for (const variant of variants) {
    if (
      variant.contentItemId !== item.id ||
      !liveStates.includes(variant.state) ||
      variant.assetIds.length > 0 ||
      !channels.some(
        (channel) =>
          channel.id === variant.channelId &&
          reelKinds.includes(channel.kind) &&
          (!input.kinds || input.kinds.includes(channel.kind)),
      )
    )
      continue;
    await deps.content.updateVariant({
      ...variant,
      assetIds: [input.assetId],
    });
  }
};
