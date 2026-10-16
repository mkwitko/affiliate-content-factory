import { createHash } from "node:crypto";
import { type Asset, createAsset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  type MusicLibrary,
  type MusicPlatform,
  type MusicTrack,
  nicheWords,
  readNicheMusicPrefs,
  recentTrackLimit,
  selectReelTrack,
  trackAllowedOn,
} from "@money-maker/core/assets/reel-music";
import type { ReelRenderer } from "@money-maker/core/assets/reel-renderer";
import { buildReelTimeline, type ReelClip } from "@money-maker/core/assets/reel-timeline";
import type { SpeechSynthesizer } from "@money-maker/core/assets/speech-synthesizer";
import { resolveNicheCaptionTheme } from "@money-maker/core/brand/caption-style";
import { readVideoMarkPlan } from "@money-maker/core/brand/video-mark";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { ContentVariant } from "@money-maker/core/content/content";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import { isAutoSaleItem } from "@money-maker/core/content/offer-package";
import type { JobIdentifierPayload } from "@money-maker/core/jobs/job";
import {
  createCheckNarrationJob,
  type JobContext,
  type JobQueue,
  jobAbortReason,
  renderReelMaxAttempts,
} from "@money-maker/core/jobs/job";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import {
  type AutoReelDeps,
  attachAutoReelAsset,
  autoReelKindsAwaiting,
} from "@money-maker/core/publishing/auto-reels";
import {
  assertReelSourceVariant,
  type ReelRenderRepository,
} from "@money-maker/core/publishing/reel-render";
import {
  countTtsCache,
  qualityBlockReason,
  withCacheHits,
  withMusicCheck,
} from "@money-maker/core/publishing/render-quality";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { loadVideoMark } from "./video-mark.js";

type NicheLookup = Readonly<{
  contentItems: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
}>;

export type RenderReelDependencies = Readonly<{
  content: Pick<ContentRepository, "findVariantForWorkspace">;
  channels: Pick<ChannelRepository, "findForWorkspace">;
  /** Auto packages: render from the draft carousel and fill the Reels drafts. Absent = approved only. */
  autoReels?: Pick<AutoReelDeps, "content" | "channels">;
  renders: ReelRenderRepository;
  /** Enqueues the narration check of a voiced Reel; absent skips it. */
  jobs?: Pick<JobQueue, "enqueue">;
  assets: AssetStore;
  assetRepository: Pick<AssetRepository, "create" | "findForWorkspace" | "updateState">;
  renderer: ReelRenderer;
  /** Background music; absent renders silent Reels. */
  music?: Readonly<{ library: MusicLibrary } & NicheLookup>;
  /** Voice-over; absent means a voiced script fails with voice_unavailable. */
  speech?: Readonly<{ synthesizer: SpeechSynthesizer; defaultVoiceId: string } & NicheLookup>;
  /**
   * 2.5D: moves an in-scene slide's scene by its depth map under the slide's still text layer
   * and returns a 1080x1920 MP4. Absent (REEL_PARALLAX unset) keeps still slides.
   */
  parallax?: (input: ParallaxSlideInput) => Promise<Uint8Array>;
}>;

export type ParallaxSlideInput = Readonly<{
  scene: Uint8Array;
  depth: Uint8Array;
  overlay: Uint8Array;
  width: number;
  height: number;
  index: number;
  durationSec: number;
}>;

/** The post's niche, or null when it has none or the lookup fails; niche context is optional. */
const findNiche = async (variant: ContentVariant, lookup: NicheLookup): Promise<Niche | null> => {
  const item = await lookup.contentItems.findContentItemForWorkspace({
    workspaceId: variant.workspaceId,
    contentItemId: variant.contentItemId,
  });
  if (!item) return null;
  return lookup.niches.findForWorkspace({
    workspaceId: variant.workspaceId,
    nicheId: item.nicheId,
  });
};

/** Picks the track for this post's niche and hook; a music lookup failure never fails the render. */
const chooseTrack = async (
  dependencies: RenderReelDependencies,
  variant: ContentVariant,
  niche: Niche | null,
  platform: MusicPlatform,
) => {
  const music = dependencies.music;
  if (!music) return undefined;
  const tracks = await music.library.listTracks();
  if (tracks.length === 0) return undefined;
  return selectReelTrack({
    tracks,
    nicheWords: niche ? nicheWords(niche) : [],
    nicheMoods: readNicheMusicPrefs(niche).moods,
    ...(variant.creativeFeatures ? { features: variant.creativeFeatures } : {}),
    recentTrackIds: await dependencies.renders.recentMusicTrackIds({
      workspaceId: variant.workspaceId,
      limit: recentTrackLimit,
    }),
    platform,
  });
};

const transientVoice = /^voice_synthesis_failed:(timeout|network)$/;

type RenderReelJob = Readonly<{ payload: JobIdentifierPayload; attemptCount?: number }>;

const maxSlideBytes = 15_000_000;
/** The ffmpeg renderer's slide length without a voice timeline (v1 edit). */
const defaultSlideSec = 4;

/**
 * Renders one Reel from an approved/published carousel's own slides. Any failure (missing
 * source, unsupported asset, ffmpeg error) records the ReelRender row as failed and stops;
 * the operator retries by calling render_reel again (see job.ts's renderReelMaxAttempts note).
 */
export const createRenderReelHandler =
  (dependencies: RenderReelDependencies) =>
  async (job: RenderReelJob, context?: JobContext): Promise<void> => {
    const signal = context?.signal;
    const workspaceId = job.payload.workspaceId;
    const sourceVariantId = job.payload.identifiers.sourceVariantId;
    if (!sourceVariantId) throw new Error("reel_source_variant_id_missing");

    const fail = (reason: string) =>
      dependencies.renders.recordFailed({ workspaceId, sourceVariantId, reason });
    const image = async (assetId: unknown): Promise<Uint8Array | null> => {
      if (typeof assetId !== "string") return null;
      const asset = await dependencies.assetRepository.findForWorkspace({ workspaceId, assetId });
      if (!asset || asset.state === "archived") return null;
      const target = await dependencies.assets.createDownload({ workspaceId, assetId });
      const media = await fetchSafeMedia(new URL(target.url), {
        maxBytes: maxSlideBytes,
        allowedMimeTypes: ["image/png", "image/jpeg"],
      });
      return media.bytes;
    };
    /** The slide as a 2.5D clip, or null when a layer is missing or the clip fails (still slide). */
    const parallaxSlide = async (
      slide: Asset,
      index: number,
      durationSec: number,
    ): Promise<Uint8Array | null> => {
      const parallax = dependencies.parallax;
      const sceneId = slide.metadata?.sceneAssetId;
      if (!parallax || typeof sceneId !== "string" || !slide.metadata?.overlayAssetId) return null;
      try {
        const scene = await dependencies.assetRepository.findForWorkspace({
          workspaceId,
          assetId: sceneId,
        });
        const [sceneBytes, depth, overlay] = await Promise.all([
          image(sceneId),
          image(scene?.metadata?.depthAssetId),
          image(slide.metadata.overlayAssetId),
        ]);
        if (!sceneBytes || !depth || !overlay) return null;
        return await parallax({
          scene: sceneBytes,
          depth,
          overlay,
          width: slide.width,
          height: slide.height,
          index,
          durationSec,
        });
      } catch {
        return null;
      }
    };

    const render = await dependencies.renders.findForWorkspace({ workspaceId, sourceVariantId });
    // Already resolved (or an unknown row): nothing to do. The job queue's idempotencyKey
    // keeps a duplicate enqueue from creating a second job for the same source variant.
    if (render?.status !== "pending") return;

    const variant = await dependencies.content.findVariantForWorkspace({
      workspaceId,
      variantId: sourceVariantId,
    });
    if (!variant) return void (await fail("content_not_found"));
    const channel = await dependencies.channels.findForWorkspace({
      workspaceId,
      channelId: variant.channelId,
    });
    if (!channel) return void (await fail("content_not_found"));
    const sourceItem = await dependencies.autoReels?.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId: variant.contentItemId,
    });
    try {
      assertReelSourceVariant(variant, channel, {
        allowDraft: sourceItem != null && isAutoSaleItem(sourceItem),
      });
    } catch (error) {
      await fail(error instanceof Error ? error.message : "reel_source_invalid");
      return;
    }

    const wantsVoice = render.voiceMode === "script" && variant.voiceScript.length > 0;

    try {
      let voiceId: string | undefined;
      let voiceClips: Uint8Array[] | undefined;
      const ttsResults: Array<Readonly<{ cached?: boolean }>> = [];
      let timeline: ReturnType<typeof buildReelTimeline> | undefined;

      // Resolved once and shared: the voice mode reads the niche's preferred voiceId, and
      // chooseTrack reads the same niche's mood words for the background track.
      const nicheLookup = wantsVoice ? dependencies.speech : dependencies.music;
      const niche = nicheLookup ? await findNiche(variant, nicheLookup).catch(() => null) : null;
      // Picked before the voice timeline: a track with a tempo puts the cuts on its beats.
      // The Reel's own music must be licensed on Instagram, where it is published first; a TikTok
      // edition with other music (or none) follows when the track does not cover TikTok.
      const track = await chooseTrack(dependencies, variant, niche, "instagram").catch(
        () => undefined,
      );

      if (wantsVoice) {
        const speech = dependencies.speech;
        if (!speech) return void (await fail("voice_failed:voice_unavailable"));

        const contextVoice =
          niche?.context && typeof niche.context["voiceId"] === "string"
            ? niche.context["voiceId"]
            : undefined;
        voiceId = contextVoice ?? speech.defaultVoiceId;

        const clips: ReelClip[] = [];
        const bytes: Uint8Array[] = [];
        try {
          for (const text of variant.voiceScript) {
            // Serial, not parallel: the sidecar synthesizes one clip at a time and this keeps
            // the worker's memory footprint down for long carousels.
            const result = await speech.synthesizer.synthesize({
              text,
              voiceId,
              language: variant.language,
              workspaceId,
            });
            ttsResults.push(result);
            bytes.push(result.bytes);
            clips.push({ durationMs: result.durationMs, words: result.words });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "voice_synthesis_failed";
          // Kokoro on the busy VM CPU can time out: the job retries (cached lines are skipped)
          // before the render fails for good.
          if (transientVoice.test(message) && (job.attemptCount ?? 1) < renderReelMaxAttempts)
            throw error;
          return void (await fail(`voice_failed:${message}`));
        }
        voiceClips = bytes;

        try {
          timeline = buildReelTimeline({
            slideCount: variant.assetIds.length,
            clips,
            ...(track?.bpm ? { beatSec: 60 / track.bpm } : {}),
            ...(dependencies.renderer.crossfadeSec !== undefined
              ? { crossfadeSec: dependencies.renderer.crossfadeSec }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "reel_too_long";
          return void (await fail(`voice_failed:${message}`));
        }
      }

      const slides: Parameters<ReelRenderer["render"]>[0]["slides"][number][] = [];
      for (const [index, assetId] of variant.assetIds.entries()) {
        const asset = await dependencies.assetRepository.findForWorkspace({
          workspaceId,
          assetId,
        });
        if (asset?.state !== "active") throw new Error("asset_unavailable");
        const clip = await parallaxSlide(
          asset,
          index,
          timeline?.slides[index]?.durationSec ?? defaultSlideSec,
        );
        if (clip) {
          slides.push({ bytes: clip, mimeType: "video/mp4", width: 1080, height: 1920 });
          continue;
        }
        const target = await dependencies.assets.createDownload({ workspaceId, assetId });
        const media = await fetchSafeMedia(new URL(target.url), {
          maxBytes: maxSlideBytes,
          allowedMimeTypes: channel.capabilities.allowedMimeTypes,
        });
        slides.push({
          bytes: media.bytes,
          mimeType: media.mimeType,
          width: asset.width,
          height: asset.height,
        });
      }
      const captionTheme = resolveNicheCaptionTheme({
        niche,
        channel,
        canvas: "portrait",
        channelKind: channel.kind,
      });
      const musicVolume = readNicheMusicPrefs(niche).volume;
      const mark = await loadVideoMark({
        plan: readVideoMarkPlan(niche, channel),
        workspaceId,
        assets: dependencies.assetRepository,
        store: dependencies.assets,
      });
      signal?.throwIfAborted();
      const renderWith = (music: MusicTrack | undefined) =>
        dependencies.renderer.render(
          {
            slides,
            ...(timeline ? { timeline } : {}),
            ...(voiceClips ? { voiceClips } : {}),
            ...(music ? { musicFile: music.file } : {}),
            ...(musicVolume ? { musicVolume } : {}),
            ...(mark ? { mark } : {}),
            ...(captionTheme ? { captionStyle: { theme: captionTheme } } : {}),
          },
          ...(signal ? [{ signal }] : []),
        );
      const storeVideo = async (
        output: Awaited<ReturnType<typeof renderWith>>,
        extra: Record<string, unknown> = {},
      ) => {
        const created = createAsset({
          workspaceId,
          mimeType: output.mimeType,
          checksum: createHash("sha256").update(output.bytes).digest("hex"),
          byteSize: output.bytes.byteLength,
          durationMs: output.durationMs,
          width: output.width,
          height: output.height,
          provenance: "rendered",
          license: "Rendered from approved carousel slides",
          metadata: { sourceAssetIds: [...variant.assetIds], role: "reel_video", ...extra },
        });
        if (!created.ok) throw new Error("reel_asset_invalid");
        await dependencies.assets.putObject({
          workspaceId,
          assetId: created.asset.id,
          mimeType: created.asset.mimeType,
          checksum: created.asset.checksum,
          width: created.asset.width,
          height: created.asset.height,
          bytes: output.bytes,
        });
        await dependencies.assetRepository.create(created.asset);
        await dependencies.assetRepository.updateState({
          workspaceId,
          assetId: created.asset.id,
          state: "active",
        });
        return created.asset;
      };
      const output = await renderWith(track);
      // A blocked render never becomes an asset, so nothing downstream can approve or publish it.
      const qualityReport = withCacheHits(
        withMusicCheck(output.quality, track ?? false),
        countTtsCache(ttsResults),
      );
      const blocked = qualityBlockReason(output.quality);
      if (blocked)
        return void (await dependencies.renders.recordFailed({
          workspaceId,
          sourceVariantId,
          reason: blocked,
          qualityReport,
        }));
      const created = { asset: await storeVideo(output) };
      const ready = await dependencies.renders.recordReady({
        workspaceId,
        sourceVariantId,
        assetId: created.asset.id,
        ...(track ? { musicTrackId: track.id } : {}),
        ...(voiceId ? { voiceId } : {}),
        durationMs: output.durationMs,
        ...(qualityReport ? { qualityReport } : {}),
      });
      // Another attempt resolved this render first: keep its result, take this asset out of use.
      if (ready.assetId !== created.asset.id)
        await dependencies.assetRepository.updateState({
          workspaceId,
          assetId: created.asset.id,
          state: "archived",
        });
      else {
        if (dependencies.autoReels) {
          const autoReels = dependencies.autoReels;
          const awaiting = await autoReelKindsAwaiting(autoReels, { workspaceId, source: variant });
          // Music licensed only on Meta (Meta Sound Collection) never reaches TikTok: the TikTok
          // drafts get their own edition with a TikTok-licensed track, or no music.
          const tiktokEdition =
            awaiting.has("tiktok_video") && track !== undefined && !trackAllowedOn(track, "tiktok");
          await attachAutoReelAsset(autoReels, {
            workspaceId,
            source: variant,
            assetId: created.asset.id,
            ...(tiktokEdition ? { kinds: ["instagram_reels"] } : {}),
          });
          if (tiktokEdition) {
            const tiktokTrack = await chooseTrack(dependencies, variant, niche, "tiktok").catch(
              () => undefined,
            );
            const edition = await renderWith(tiktokTrack);
            // A blocked edition leaves the TikTok drafts without a video: never publishable.
            if (!qualityBlockReason(edition.quality)) {
              const asset = await storeVideo(edition, {
                edition: "tiktok",
                ...(tiktokTrack ? { musicTrackId: tiktokTrack.id } : { music: "none" }),
              });
              await attachAutoReelAsset(autoReels, {
                workspaceId,
                source: variant,
                assetId: asset.id,
                kinds: ["tiktok_video"],
              });
            }
          }
        }
        // Wrong spoken prices must block like wrong written ones; never fails a ready render.
        if (voiceId && dependencies.jobs)
          await dependencies.jobs
            .enqueue(
              createCheckNarrationJob({ workspaceId, sourceVariantId, assetId: created.asset.id }),
            )
            .catch(() => undefined);
      }
    } catch (error) {
      const aborted = jobAbortReason(signal);
      // A deploy stops the worker mid-render: leave the render pending for the next attempt.
      const transient =
        aborted === "worker_shutdown" ||
        (!aborted && error instanceof Error && transientVoice.test(error.message));
      if (transient && (job.attemptCount ?? 1) < renderReelMaxAttempts) throw error;
      await fail(aborted ?? (error instanceof Error ? error.message : "reel_render_failed"));
    }
  };
