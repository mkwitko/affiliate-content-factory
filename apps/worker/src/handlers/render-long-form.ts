import { createHash } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { createAsset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import { clipSeconds } from "@money-maker/core/assets/local-clip-profile";
import {
  type MusicLibrary,
  type MusicVolume,
  readNicheMusicPrefs,
} from "@money-maker/core/assets/reel-music";
import type { ReelRenderer } from "@money-maker/core/assets/reel-renderer";
import { buildReelTimeline, type ReelClip } from "@money-maker/core/assets/reel-timeline";
import type { SpeechSynthesizer } from "@money-maker/core/assets/speech-synthesizer";
import type { StageCache } from "@money-maker/core/assets/stage-cache";
import {
  type ResolvedCaptionTheme,
  resolveNicheCaptionTheme,
} from "@money-maker/core/brand/caption-style";
import { readVideoMarkPlan, type VideoMarkPlan } from "@money-maker/core/brand/video-mark";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import type { SceneClipStateRepository } from "@money-maker/core/content/scene-clip-state";
import {
  type ClipScene,
  isClipStoryboard,
  isOwnedClipReference,
  isSceneSpecStoryboard,
  type Storyboard,
  type StoryboardScene,
} from "@money-maker/core/content/storyboard";
import type { StoryboardRepository } from "@money-maker/core/content/storyboard-repository";
import { reserveCost } from "@money-maker/core/costs/cost-event";
import type { CostRepository } from "@money-maker/core/costs/cost-repository";
import {
  AMBIENT_LOOP_LIMITS,
  AMBIENT_LOOP_ROLE,
  type BackgroundArt,
  explainerLineStyle,
  isUsableBackground,
  isUsableLoop,
  type LineStyle,
} from "@money-maker/core/explainer/background-art";
import {
  composeSceneSvg,
  type SceneComposeContext,
} from "@money-maker/core/explainer/compose-scene";
import type { CompositingProfile } from "@money-maker/core/explainer/compositing";
import {
  composeDialogueTimeline,
  type DialogueTimeline,
  type LineClip,
} from "@money-maker/core/explainer/dialogue";
import {
  type ExplainerCharacter,
  readExplainerContext,
  scenePaletteFor,
} from "@money-maker/core/explainer/explainer-context";
import { FRAME, MEDIA_CAPTION_MARGIN_V } from "@money-maker/core/explainer/layout";
import type { Location } from "@money-maker/core/explainer/locations";
import type { ChunkCache } from "@money-maker/core/explainer/motion/chunks";
import { planMotion, TRANSITION_MS } from "@money-maker/core/explainer/motion/plan";
import { type SceneSpec, sceneChecksum, sceneMotion } from "@money-maker/core/explainer/scene-spec";
import type { VisualLanguageProfile } from "@money-maker/core/explainer/visual-language";
import { blockReasons } from "@money-maker/core/explainer/visual-qa/tunables";
import { characterVoiceId } from "@money-maker/core/explainer/voice";
import {
  type JobContext,
  type JobIdentifierPayload,
  jobAbortReason,
} from "@money-maker/core/jobs/job";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { LongFormRenderRepository } from "@money-maker/core/publishing/long-form-render";
import {
  countTtsCache,
  qualityBlockReason,
  withCacheHits,
  withClipFallbacks,
} from "@money-maker/core/publishing/render-quality";
import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import type { VisualQa } from "@money-maker/providers/media/frame-metrics";
import type { StickmanMotionRenderer } from "@money-maker/providers/media/stickman-motion-renderer";
import { loadVideoMark } from "./video-mark.js";

const maxSceneBytes = 8_000_000;
const maxClipBytes = 50_000_000;
/** Generated clips are requested and checked at this portrait size (generate-scene-clips.ts). */
const CLIP_FRAME = { width: 768, height: 1152 } as const;
const maxRenderBytes = 80_000_000;
const maxSpeechBytes = 120_000_000;
const maxDurationSec = 900;
const MAX_LOOPS_PER_RENDER = 3;
const tokenize = (text: string): readonly { token: string; from: number; to: number }[] =>
  [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    token: match[0].normalize("NFC").toLowerCase(),
    from: match.index ?? 0,
    to: (match.index ?? 0) + match[0].length,
  }));

const wordOffsets = (
  text: string,
  words: readonly { text: string }[],
): readonly { fromChar: number; toChar: number }[] | undefined => {
  const tokens = tokenize(text);
  if (tokens.length !== words.length) return undefined;
  const offsets = [];
  for (const [index, word] of words.entries()) {
    const token = word.text
      .normalize("NFC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
    const match = tokens[index];
    if (!match || token !== match.token) return undefined;
    offsets.push({ fromChar: match.from, toChar: match.to });
  }
  return offsets;
};
export type RenderLongFormDependencies = Readonly<{
  storyboards: StoryboardRepository;
  scripts: EditorialRepository;
  renders: LongFormRenderRepository;
  assets: AssetRepository;
  store: AssetStore;
  renderer: ReelRenderer;
  speech: SpeechSynthesizer;
  music?: MusicLibrary;
  /** stickman_still storyboards: niche cast lookup and SVG rasterization. */
  content?: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches?: Pick<NicheRepository, "findForWorkspace">;
  rasterizer?: (
    svg: string,
    size: Readonly<{ width: number; height: number }>,
  ) => Promise<Uint8Array>;
  costs?: CostRepository;
  /** ai_clips storyboards: which stored clip belongs to which scene. */
  clipState?: SceneClipStateRepository;
  /** ai_clips: slow zoom over a still plate, for a scene whose local clip fell back (zoompan). */
  staticClip?: (input: {
    image: Uint8Array;
    width: number;
    height: number;
    seconds: number;
  }) => Promise<Uint8Array>;
  /** stickman_motion storyboards: frame-by-frame animation. */
  motionRenderer?: StickmanMotionRenderer;
  /**
   * stickman_motion long-form: stores finished chunk videos so a retry or a re-requested render
   * skips them (stage "motion_chunk"). Absent still chunks, without recovery.
   */
  chunkStore?: StageCache;
  /** Running build (MONEY_MAKER_RELEASE). Unknown disables chunk reuse: stale code must not be cached. */
  codeVersion?: string;
  /** stickman_motion: thumbnail gate and visual QA section (v2 slice 28); absent skips both. */
  visualQa?: VisualQa;
  /** stickman_motion: decodes an ambient loop to JPEG frames (providers extractLoopFrames). */
  loopFrames?: (
    bytes: Uint8Array,
    options: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<readonly Uint8Array[]>;
}>;

type PreparedScene = Readonly<{
  index: number;
  fromChar: number;
  toChar: number;
  /** Absent for stickman_motion scenes, which are drawn frame by frame instead. */
  slide?: Readonly<{ bytes: Uint8Array; mimeType: string; width: number; height: number }>;
  sourceAssetId: string;
  sourceAssetChecksum: string;
  motion: StoryboardScene["motion"];
  captionMode: StoryboardScene["captionMode"];
}>;
type Prepared =
  | Readonly<{
      ok: true;
      scenes: readonly PreparedScene[];
      /** stickman_motion: painted backgrounds by asset id, and every asset the render draws. */
      art?: ReadonlyMap<string, BackgroundArt>;
      sourceAssetIds?: readonly string[];
      /** ai_clips: scenes rendered from a static plate (reported as scene_clip_fallback:<i>). */
      fallbackScenes?: readonly number[];
    }>
  | Readonly<{ ok: false; reason: string }>;
/**
 * One voice clip per scene, except dialogue scenes, whose line clips are placed at the scene's
 * voice start plus each line's offset, with their trim and duck edits (slice 32).
 */
export const flattenVoice = (
  sceneClips: readonly Uint8Array[],
  sceneStartsMs: readonly number[],
  lines: readonly (
    | Readonly<{
        clips: readonly Uint8Array[];
        startsMs: readonly number[];
        edits: DialogueTimeline["edits"];
      }>
    | undefined
  )[],
): Readonly<{
  voiceClips: readonly Uint8Array[];
  voiceStartMs: readonly number[];
  voiceEdits?: readonly (DialogueTimeline["edits"][number] | undefined)[];
}> => {
  if (!lines.some((entry) => entry)) return { voiceClips: sceneClips, voiceStartMs: sceneStartsMs };
  const voiceClips: Uint8Array[] = [];
  const voiceStartMs: number[] = [];
  const voiceEdits: (DialogueTimeline["edits"][number] | undefined)[] = [];
  sceneClips.forEach((clip, i) => {
    const start = sceneStartsMs[i] ?? 0;
    const entry = lines[i];
    if (!entry) {
      voiceClips.push(clip);
      voiceStartMs.push(start);
      voiceEdits.push(undefined);
      return;
    }
    entry.clips.forEach((line, j) => {
      voiceClips.push(line);
      voiceStartMs.push(start + (entry.startsMs[j] ?? 0));
      voiceEdits.push(entry.edits[j]);
    });
  });
  return { voiceClips, voiceStartMs, voiceEdits };
};

export const createRenderLongFormHandler =
  (deps: RenderLongFormDependencies) =>
  async (
    job: { payload: JobIdentifierPayload; attemptCount?: number },
    context?: JobContext,
  ): Promise<void> => {
    const signal = context?.signal;
    const { workspaceId, identifiers } = job.payload;
    const renderId = identifiers.renderId;
    if (!renderId) throw new Error("long_form_render_id_missing");
    const render = await deps.renders.findForWorkspace({ workspaceId, renderId });
    if (!render || render.status !== "pending") return;
    const fail = (reason: string) => deps.renders.recordFailed({ workspaceId, renderId, reason });
    const board = await deps.storyboards.findForWorkspace({
      workspaceId,
      storyboardId: render.storyboardId,
    });
    if (!board) return void (await fail("storyboard_not_found"));
    const script = await deps.scripts.findScriptForWorkspace({
      workspaceId,
      scriptId: board.scriptId,
    });
    if (!script || script.status !== "approved" || script.approvedChecksum !== script.checksum)
      return void (await fail("script_not_approved"));
    if (script.contentItemId !== board.contentItemId)
      return void (await fail("storyboard_script_mismatch"));
    let captionStyle:
      | Readonly<{
          marginV?: number;
          groupSize?: number;
          boxed?: boolean;
          theme?: ResolvedCaptionTheme;
        }>
      | undefined;
    let composeContext: SceneComposeContext | undefined;
    let markPlan: VideoMarkPlan | undefined;
    let musicVolume: MusicVolume | undefined;
    let captionWords: 2 | 3 | 4 = 3;
    let lineStyle: LineStyle = "clean";
    let compositing: CompositingProfile | undefined;
    let motionGrammar = false;
    let visualLanguage: VisualLanguageProfile | undefined;
    let locations: readonly Location[] | undefined;
    const motion = board.renderer === "stickman_motion";
    if (isSceneSpecStoryboard(board)) {
      const item = await deps.content?.findContentItemForWorkspace({
        workspaceId,
        contentItemId: board.contentItemId,
      });
      const niche = item
        ? await deps.niches?.findForWorkspace({ workspaceId, nicheId: item.nicheId })
        : null;
      const explainer = niche ? readExplainerContext(niche) : null;
      if (!niche || !explainer) return void (await fail("explainer_context_missing"));
      if (motion && !deps.motionRenderer) return void (await fail("motion_renderer_unavailable"));
      if (!motion && !deps.rasterizer) return void (await fail("rasterizer_unavailable"));
      captionWords = explainer.captionStyle.maxWords;
      lineStyle = explainerLineStyle(explainer.style);
      compositing = explainer.compositing;
      motionGrammar = explainer.motionGrammar === true;
      visualLanguage = explainer.visualLanguage;
      locations = explainer.locations;
      composeContext = { characters: explainer.characters, palette: scenePaletteFor(niche) };
      captionStyle = {
        marginV: MEDIA_CAPTION_MARGIN_V,
        groupSize: explainer.captionStyle.maxWords,
        boxed: true,
      };
      const theme = resolveNicheCaptionTheme({ niche, canvas: board.canvas });
      if (theme) captionStyle = { ...captionStyle, theme };
      markPlan = readVideoMarkPlan(niche);
      musicVolume = readNicheMusicPrefs(niche).volume;
    } else {
      // Every other storyboard gets the niche caption theme and video mark too (spec 2); none keeps
      // the default style. Stickman scenes (handled above) resolve theirs with the cast.
      const item = await deps.content?.findContentItemForWorkspace({
        workspaceId,
        contentItemId: board.contentItemId,
      });
      const niche = item
        ? await deps.niches?.findForWorkspace({ workspaceId, nicheId: item.nicheId })
        : null;
      const theme = resolveNicheCaptionTheme({ niche, canvas: board.canvas });
      if (theme) captionStyle = { theme };
      markPlan = readVideoMarkPlan(niche);
    }
    const clips = isClipStoryboard(board);
    if (clips && !deps.clipState) return void (await fail("scene_clips_unavailable"));
    const mark = motion
      ? undefined
      : await loadVideoMark({
          plan: markPlan,
          workspaceId,
          assets: deps.assets,
          store: deps.store,
        });
    const startedAt = Date.now();
    try {
      signal?.throwIfAborted();
      const prepared = clips
        ? await prepareClipScenes(board, deps, script)
        : !composeContext
          ? await prepareImageScenes(board, deps)
          : motion
            ? await prepareMotionScenes(
                board.scenes as readonly SceneSpec[],
                composeContext.characters,
                deps,
                workspaceId,
                signal,
              )
            : await prepareSpecScenes(board.scenes as readonly SceneSpec[], composeContext, deps);
      if (!prepared.ok) return void (await fail(prepared.reason));
      const scenesReady = prepared.scenes;
      const slides = scenesReady.flatMap((scene) => (scene.slide ? [scene.slide] : []));
      const timingClips: ReelClip[] = [];
      const captionClips = [];
      const voiceClips = [];
      // Dialogue scenes (slice 32): one clip per line, placed on the scene clock, flattened for
      // the motion renderer; other scenes keep one clip.
      const lineClips: (
        | { clips: Uint8Array[]; startsMs: readonly number[]; edits: DialogueTimeline["edits"] }
        | undefined
      )[] = [];
      const sourceAssetIds =
        composeContext || clips
          ? [...(prepared.sourceAssetIds ?? [])]
          : [...new Set(scenesReady.map((scene) => scene.sourceAssetId))];
      const sceneTexts: string[] = [];
      let speechByteCount = 0;
      const ttsCost = await reserveZeroCost(deps, workspaceId, "kokoro", "tts");
      const ttsResults: Array<Readonly<{ cached?: boolean }>> = [];
      for (const [sceneIndex, scene] of scenesReady.entries()) {
        signal?.throwIfAborted();
        const text = script.body.slice(scene.fromChar, scene.toChar);
        sceneTexts.push(text);
        const dialogue = motion
          ? (board.scenes[sceneIndex] as SceneSpec | undefined)?.dialogue
          : undefined;
        if (dialogue?.length && composeContext) {
          const voiceOf = (key: string) => {
            const character = composeContext?.characters.find((entry) => entry.key === key);
            return characterVoiceId(character, board.voiceId);
          };
          const clips: Uint8Array[] = [];
          const lineTimings: LineClip[] = [];
          for (const line of dialogue) {
            const spoken = await deps.speech.synthesize({
              text: script.body.slice(line.fromChar, line.toChar),
              voiceId: line.speakerKey === "narrator" ? board.voiceId : voiceOf(line.speakerKey),
              language: script.language,
              workspaceId,
            });
            ttsResults.push(spoken);
            clips.push(spoken.bytes);
            lineTimings.push({ durationMs: spoken.durationMs, words: spoken.words });
            speechByteCount += spoken.bytes.byteLength;
          }
          if (speechByteCount > maxSpeechBytes) return void (await fail("speech_assets_too_large"));
          const composed = composeDialogueTimeline(dialogue, lineTimings);
          timingClips.push({ durationMs: composed.durationMs, words: composed.words });
          captionClips.push({
            durationMs: composed.durationMs,
            words:
              scene.captionMode === "none"
                ? []
                : scene.captionMode === "line"
                  ? [{ text, startMs: 0, endMs: composed.durationMs }]
                  : composed.words,
          });
          voiceClips.push(clips[0] ?? new Uint8Array());
          lineClips.push({ clips, startsMs: composed.startsMs, edits: composed.edits });
          continue;
        }
        lineClips.push(undefined);
        const result = await deps.speech.synthesize({
          text,
          voiceId: board.voiceId,
          language: script.language,
          workspaceId,
        });
        ttsResults.push(result);
        timingClips.push({ durationMs: result.durationMs, words: result.words });
        captionClips.push({
          durationMs: result.durationMs,
          words:
            scene.captionMode === "none"
              ? []
              : scene.captionMode === "line"
                ? [{ text, startMs: 0, endMs: result.durationMs }]
                : result.words,
        });
        speechByteCount += result.bytes.byteLength;
        if (speechByteCount > maxSpeechBytes) return void (await fail("speech_assets_too_large"));
        voiceClips.push(result.bytes);
      }
      await settleZeroCost(deps, workspaceId, ttsCost);
      const timeline = buildReelTimeline({
        slideCount: scenesReady.length,
        clips: captionClips,
        maxTotalSec: maxDurationSec,
      });
      // Motion scenes overlap by a short cut, whip or fade instead of the slideshow crossfade.
      const timingTimeline = buildReelTimeline({
        slideCount: scenesReady.length,
        clips: timingClips,
        maxTotalSec: maxDurationSec,
        ...(motion ? { crossfadeSec: TRANSITION_MS / 1000 } : {}),
      });
      const tracks = deps.music ? await deps.music.listTracks() : [];
      const track = board.musicTrackId
        ? tracks.find((entry) => entry.id === board.musicTrackId)
        : undefined;
      if (board.musicTrackId && !track) return void (await fail("music_track_unavailable"));
      const renderCost = await reserveZeroCost(deps, workspaceId, "ffmpeg", "render_long_form");
      const motionPlan =
        motion && composeContext && deps.motionRenderer
          ? planMotion({
              scenes: board.scenes as readonly SceneSpec[],
              timings: timingTimeline.slides.map((slide, index) => {
                const startMs = Math.round(slide.startSec * 1000);
                const voiceStartMs = Math.round(slide.voiceStartSec * 1000);
                return {
                  startMs,
                  endMs: Math.round((slide.startSec + slide.durationSec) * 1000),
                  voiceStartMs,
                  voiceEndMs: voiceStartMs + (timingClips[index]?.durationMs ?? 0),
                  words: slide.words,
                  text: sceneTexts[index] ?? "",
                };
              }),
              characters: composeContext.characters,
              palette: composeContext.palette,
              captionWords,
              lineStyle,
              ...(compositing ? { compositing } : {}),
              ...(motionGrammar ? { motionGrammar } : {}),
              ...(visualLanguage ? { visualLanguage } : {}),
              // Slice 24: location plates are cropped by zone and varied per storyboard.
              ...(locations ? { locations, variationSeed: board.id } : {}),
              durationMs: Math.round(timingTimeline.totalSec * 1000),
              ...(board.canvas === "landscape" ? { canvas: board.canvas } : {}),
              ...(prepared.art ? { backgroundArt: prepared.art } : {}),
            })
          : undefined;
      // Thumbnail-first gate (spec 20): the hook frame is checked before the full render; only the
      // objective BLOCK list fails it, and a failing inspection never blocks a render.
      // The gate blocks only niches that opted into v2 looks or motion; storyboards of other
      // niches render as before and get the findings in the report instead (review fix).
      const v2Niche = Boolean(compositing || motionGrammar || visualLanguage);
      if (motionPlan && deps.visualQa && v2Niche) {
        const gate = await deps.visualQa.thumbnail(motionPlan).catch(() => []);
        const reasons = blockReasons(gate);
        if (reasons.length) {
          await settleZeroCost(deps, workspaceId, renderCost);
          return void (await fail(`thumbnail_check:${reasons.join(",")}`));
        }
      }
      const output =
        motionPlan && deps.motionRenderer
          ? await deps.motionRenderer.render(
              {
                plan: motionPlan,
                chunks: {
                  sourceKey: board.checksum,
                  rendererVersion: render.rendererVersion,
                  codeVersion: deps.codeVersion ?? "",
                  ...(deps.chunkStore && deps.codeVersion
                    ? {
                        cache: motionChunkCache(
                          deps.chunkStore,
                          workspaceId,
                          render.rendererVersion,
                        ),
                      }
                    : {}),
                },
                ...flattenVoice(
                  voiceClips,
                  timingTimeline.slides.map((slide) => Math.round(slide.voiceStartSec * 1000)),
                  lineClips,
                ),
              },
              ...(signal ? [{ signal }] : []),
            )
          : await deps.renderer.render(
              {
                slides,
                voiceClips,
                timeline,
                canvas: board.canvas,
                motions: scenesReady.map((scene) => scene.motion),
                ...(track ? { musicFile: track.file } : {}),
                ...(captionStyle ? { captionStyle } : {}),
                ...(mark ? { mark } : {}),
                ...(musicVolume ? { musicVolume } : {}),
              },
              ...(signal ? [{ signal }] : []),
            );
      await settleZeroCost(deps, workspaceId, renderCost);
      // A blocked render never becomes an asset, so nothing downstream can approve or publish it.
      const cacheHits = countTtsCache(ttsResults);
      const blocked = qualityBlockReason(output.quality);
      if (blocked)
        return void (await deps.renders.recordFailed({
          workspaceId,
          renderId,
          reason: blocked,
          qualityReport: withCacheHits(output.quality, cacheHits),
        }));
      const visual =
        motionPlan && deps.visualQa && output.quality
          ? await deps.visualQa.report(motionPlan).catch(() => undefined)
          : undefined;
      const qualityReport = withClipFallbacks(
        withCacheHits(
          output.quality && visual ? { ...output.quality, visual } : output.quality,
          cacheHits,
        ),
        prepared.fallbackScenes ?? [],
      );
      const created = createAsset({
        workspaceId,
        mimeType: output.mimeType,
        checksum: createHash("sha256").update(output.bytes).digest("hex"),
        byteSize: output.bytes.byteLength,
        durationMs: output.durationMs,
        width: output.width,
        height: output.height,
        provenance: "rendered",
        license: "Rendered from approved script and storyboard",
        commercialUse: null,
        metadata: {
          role: "long_form_video",
          storyboardId: board.id,
          scriptChecksum: script.checksum,
          rendererVersion: render.rendererVersion,
          sourceAssetIds,
          renderer: board.renderer,
          voiceId: board.voiceId,
          musicTrackId: board.musicTrackId,
        },
      });
      if (!created.ok) return void (await fail("long_form_asset_invalid"));
      const scenes = scenesReady.map((scene, index) => {
        const timing = timingTimeline.slides[index];
        if (!timing) throw new Error("long_form_timing_manifest_invalid");
        return {
          index: scene.index,
          fromChar: scene.fromChar,
          toChar: scene.toChar,
          startMs: Math.round(timing.startSec * 1000),
          endMs: Math.round((timing.startSec + timing.durationSec) * 1000),
          sourceAssetId: scene.sourceAssetId,
          sourceAssetChecksum: scene.sourceAssetChecksum,
        };
      });
      const words = scenesReady.flatMap((scene, index) => {
        const timing = timingTimeline.slides[index];
        const text = sceneTexts[index];
        if (!timing || text === undefined) throw new Error("long_form_timing_manifest_invalid");
        const offsets = wordOffsets(text, timing.words);
        return timing.words.map((word, wordIndex) => {
          const offset = offsets?.[wordIndex];
          return {
            text: word.text,
            ...(offset
              ? {
                  fromChar: scene.fromChar + offset.fromChar,
                  toChar: scene.fromChar + offset.toChar,
                }
              : {}),
            startMs: Math.round(word.startMs),
            endMs: Math.round(word.endMs),
            sceneIndex: scene.index,
          };
        });
      });
      const timingManifest = buildRenderTimingManifest({
        workspaceId,
        renderId,
        storyboardId: board.id,
        storyboardChecksum: board.checksum,
        scriptId: script.id,
        scriptChecksum: script.checksum,
        scriptLength: script.body.length,
        renderedAssetId: created.asset.id,
        renderedAssetChecksum: created.asset.checksum,
        rendererVersion: render.rendererVersion,
        durationMs: output.durationMs,
        audioTimelineOffsetMs: 0,
        measuredAt: new Date().toISOString(),
        scenes,
        words,
      });
      await deps.store.putObject({
        workspaceId,
        assetId: created.asset.id,
        mimeType: output.mimeType,
        checksum: created.asset.checksum,
        width: output.width,
        height: output.height,
        bytes: output.bytes,
      });
      await deps.assets.create(created.asset);
      await deps.assets.updateState({ workspaceId, assetId: created.asset.id, state: "active" });
      await deps.renders.recordReady({
        workspaceId,
        renderId,
        assetId: created.asset.id,
        assetChecksum: created.asset.checksum,
        durationMs: output.durationMs,
        wallTimeMs: Date.now() - startedAt,
        timingManifest,
        ...(qualityReport ? { qualityReport } : {}),
      });
    } catch (error) {
      const aborted = jobAbortReason(signal);
      if (aborted === "render_timeout") return void (await fail("render_timeout"));
      const reason = aborted ?? (error instanceof Error ? error.message : "ffmpeg_failed");
      if (
        (job.attemptCount ?? 1) < 2 &&
        !["script_not_approved", "storyboard_not_found"].includes(reason) &&
        !reason.startsWith("reel_too_long:")
      )
        throw error;
      await fail(reason.slice(0, 500));
    }
  };

/** Chunk videos ride the stage cache; the identity already hashes every input of the chunk. */
const motionChunkCache =
  (store: StageCache, workspaceId: WorkspaceId, rendererVersion: number): ChunkCache =>
  async (identity, produce) =>
    (
      await store.getOrProduce({
        workspaceId,
        stage: "motion_chunk",
        version: String(rendererVersion),
        inputs: identity,
        produce: async () => ({ bytes: await produce(), mimeType: "video/mp4", metadata: {} }),
      })
    ).bytes;

/**
 * ai_clips: loads each scene's stored clip (the stage-cache asset generate_scene_clips recorded)
 * before any narration is paid for. Every clip and reference asset is credited as a source, so
 * the render inherits their rights: an Agnes clip has commercialUse null until the owner records
 * G0, which keeps the render unapprovable and unpublishable (spec 2, INV-G2).
 */
const prepareClipScenes = async (
  board: Storyboard & { scenes: readonly ClipScene[] },
  deps: RenderLongFormDependencies,
  script: Readonly<{ body: string; language: string }>,
): Promise<Prepared> => {
  const { workspaceId } = board;
  if (!deps.clipState) return { ok: false, reason: "scene_clips_unavailable" };
  const states = await deps.clipState.read({ workspaceId, storyboardId: board.id });
  const scenes: PreparedScene[] = [];
  const clipIds: string[] = [];
  const fallbackScenes: number[] = [];
  let byteCount = 0;
  for (const scene of board.scenes) {
    const state = states[String(scene.index)];
    if (state?.status === "fallback_static") {
      const clip = await staticPlateClip(board, scene, deps, script);
      if (!clip) return { ok: false, reason: `scene_clip_missing:${scene.index}` };
      byteCount += clip.bytes.byteLength;
      if (byteCount > maxRenderBytes * 4) return { ok: false, reason: "scene_assets_too_large" };
      fallbackScenes.push(scene.index);
      scenes.push({
        index: scene.index,
        fromChar: scene.fromChar,
        toChar: scene.toChar,
        slide: { bytes: clip.bytes, mimeType: "video/mp4", ...CLIP_FRAME },
        sourceAssetId: clip.assetId,
        sourceAssetChecksum: clip.checksum,
        motion: "static",
        captionMode: scene.captionMode,
      });
      continue;
    }
    const asset =
      state?.status === "ready" && state.assetId
        ? await deps.assets.findForWorkspace({ workspaceId, assetId: state.assetId })
        : null;
    if (
      !asset ||
      asset.workspaceId !== workspaceId ||
      asset.state !== "active" ||
      asset.mimeType !== "video/mp4"
    )
      return { ok: false, reason: `scene_clip_missing:${scene.index}` };
    const target = await deps.store.createDownload({ workspaceId, assetId: asset.id });
    const media = await fetchSafeMedia(new URL(target.url), {
      maxBytes: maxClipBytes,
      allowedMimeTypes: ["video/mp4"],
    });
    byteCount += media.bytes.byteLength;
    if (byteCount > maxRenderBytes * 4) return { ok: false, reason: "scene_assets_too_large" };
    clipIds.push(asset.id);
    scenes.push({
      index: scene.index,
      fromChar: scene.fromChar,
      toChar: scene.toChar,
      // Stage-cache assets carry no pixel size; the clip was checked against CLIP_FRAME.
      slide: { bytes: media.bytes, mimeType: media.mimeType, ...CLIP_FRAME },
      sourceAssetId: asset.id,
      sourceAssetChecksum: asset.checksum,
      motion: "static",
      captionMode: scene.captionMode,
    });
  }
  const references = board.scenes.flatMap((scene) =>
    scene.referenceAssetId === undefined ? [] : [scene.referenceAssetId],
  );
  return {
    ok: true,
    scenes,
    sourceAssetIds: [...new Set([...clipIds, ...references])],
    fallbackScenes,
  };
};

const STATIC_CLIP_SIZE = {
  landscape: { width: 1280, height: 720 },
  portrait: { width: 720, height: 1280 },
} as const;
/** The owned reference plate as a slow zoom clip of the scene's length; null if unavailable. */
const staticPlateClip = async (
  board: Storyboard & { scenes: readonly ClipScene[] },
  scene: ClipScene,
  deps: RenderLongFormDependencies,
  script: Readonly<{ body: string; language: string }>,
): Promise<Readonly<{ bytes: Uint8Array; assetId: string; checksum: string }> | null> => {
  if (!deps.staticClip || scene.referenceAssetId === undefined) return null;
  const { workspaceId } = board;
  const asset = await deps.assets.findForWorkspace({
    workspaceId,
    assetId: scene.referenceAssetId,
  });
  if (!isOwnedClipReference(asset, workspaceId) || !asset) return null;
  const target = await deps.store.createDownload({ workspaceId, assetId: asset.id });
  const image = await fetchSafeMedia(new URL(target.url), {
    maxBytes: maxSceneBytes,
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  });
  const bytes = await deps.staticClip({
    image: image.bytes,
    ...STATIC_CLIP_SIZE[board.canvas],
    seconds: clipSeconds(script.body.slice(scene.fromChar, scene.toChar), script.language),
  });
  return { bytes, assetId: asset.id, checksum: asset.checksum };
};

/** Fetches each scene's image asset; used by slideshow storyboards. */
const prepareImageScenes = async (
  board: Storyboard,
  deps: RenderLongFormDependencies,
): Promise<Prepared> => {
  const { workspaceId } = board;
  const scenes: PreparedScene[] = [];
  let byteCount = 0;
  for (const scene of board.scenes as readonly StoryboardScene[]) {
    const asset = await deps.assets.findForWorkspace({ workspaceId, assetId: scene.assetId });
    if (
      !asset ||
      asset.workspaceId !== workspaceId ||
      asset.state !== "active" ||
      !asset.mimeType.startsWith("image/")
    )
      return { ok: false, reason: `scene_asset_missing:${scene.index}` };
    const target = await deps.store.createDownload({ workspaceId, assetId: asset.id });
    const media = await fetchSafeMedia(new URL(target.url), {
      maxBytes: maxSceneBytes,
      allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
    });
    byteCount += media.bytes.byteLength;
    if (byteCount > maxRenderBytes) return { ok: false, reason: "scene_assets_too_large" };
    scenes.push({
      index: scene.index,
      fromChar: scene.fromChar,
      toChar: scene.toChar,
      slide: {
        bytes: media.bytes,
        mimeType: media.mimeType,
        width: asset.width,
        height: asset.height,
      },
      sourceAssetId: asset.id,
      sourceAssetChecksum: asset.checksum,
      motion: scene.motion,
      captionMode: scene.captionMode,
    });
  }
  return { ok: true, scenes };
};

/**
 * stickman_motion: checks the cast and loads each painted background once, before any narration
 * is paid for. Frames are drawn later from the motion plan. A background that is missing or lost
 * its rights since the storyboard was made is skipped; planMotion then draws the procedural
 * setting and notes background_fallback:<n>.
 */
const prepareMotionScenes = async (
  specs: readonly SceneSpec[],
  characters: readonly ExplainerCharacter[],
  deps: RenderLongFormDependencies,
  workspaceId: Storyboard["workspaceId"],
  signal: AbortSignal | undefined,
): Promise<Prepared> => {
  const keys = new Set(characters.map((character) => character.key));
  const missing = specs.find((scene) =>
    scene.actors.some((actor) => !keys.has(actor.characterKey)),
  );
  if (missing) return { ok: false, reason: `scene_character_missing:${missing.index}` };
  const art = new Map<string, BackgroundArt>();
  const sourceAssetIds: string[] = [];
  let byteCount = 0;
  let loops = 0;
  const ids = new Set(
    specs.flatMap((scene) =>
      scene.backgroundAssetId === undefined ? [] : [scene.backgroundAssetId],
    ),
  );
  for (const id of ids) {
    signal?.throwIfAborted();
    const asset = await deps.assets.findForWorkspace({ workspaceId, assetId: id });
    if (!isUsableBackground(asset, workspaceId)) continue;
    const target = await deps.store.createDownload({ workspaceId, assetId: asset.id });
    const media = await fetchSafeMedia(new URL(target.url), {
      maxBytes: maxSceneBytes,
      allowedMimeTypes: ["image/jpeg", "image/png"],
    });
    byteCount += media.bytes.byteLength;
    if (byteCount > maxRenderBytes) return { ok: false, reason: "scene_assets_too_large" };
    const href = `data:${media.mimeType};base64,${Buffer.from(media.bytes).toString("base64")}`;
    sourceAssetIds.push(asset.id);
    let loop: BackgroundArt["loop"];
    const attached =
      deps.loopFrames && loops < MAX_LOOPS_PER_RENDER
        ? [
            ...((await deps.assets.listByMetadata?.({
              workspaceId,
              role: AMBIENT_LOOP_ROLE,
              key: "backgroundAssetId",
              value: asset.id,
            })) ?? []),
          ]
            .sort((a, b) => a.id.localeCompare(b.id))
            .find((candidate) => isUsableLoop(candidate, workspaceId, asset.id))
        : undefined;
    if (attached && deps.loopFrames) {
      try {
        const clip = await deps.store.createDownload({ workspaceId, assetId: attached.id });
        const video = await fetchSafeMedia(new URL(clip.url), {
          maxBytes: AMBIENT_LOOP_LIMITS.maxBytes,
          allowedMimeTypes: ["video/mp4"],
        });
        const frames = await deps.loopFrames(video.bytes, signal ? { signal } : {});
        if (frames.length > 0) {
          loop = {
            frames: frames.map(
              (frame) => `data:image/jpeg;base64,${Buffer.from(frame).toString("base64")}`,
            ),
            fps: AMBIENT_LOOP_LIMITS.fps,
          };
          loops += 1;
          sourceAssetIds.push(attached.id);
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        // INV-06: an unreadable loop falls back to the approved still, and says so.
        console.warn("fallback_used", {
          workspaceId,
          assetId: attached.id,
          reason: "ambient_loop_unavailable",
        });
      }
    }
    art.set(asset.id, loop ? { href, loop } : { href });
  }
  return {
    ok: true,
    art,
    sourceAssetIds,
    scenes: specs.map((scene) => ({
      index: scene.index,
      fromChar: scene.fromChar,
      toChar: scene.toChar,
      sourceAssetId: `scene-spec:${scene.index}`,
      sourceAssetChecksum: sceneChecksum(scene),
      motion: sceneMotion(scene.camera),
      captionMode: scene.captionMode,
    })),
  };
};

/** Composes and rasterizes every SceneSpec before any narration is paid for. */
const prepareSpecScenes = async (
  specs: readonly SceneSpec[],
  context: SceneComposeContext,
  deps: RenderLongFormDependencies,
): Promise<Prepared> => {
  const svgs: string[] = [];
  for (const scene of specs) {
    try {
      svgs.push(composeSceneSvg(scene, context));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("scene_character_missing:"))
        return { ok: false, reason: error.message };
      throw error;
    }
  }
  const scenes: PreparedScene[] = [];
  for (const [position, scene] of specs.entries()) {
    const svg = svgs[position];
    if (svg === undefined || !deps.rasterizer)
      return { ok: false, reason: "rasterizer_unavailable" };
    const bytes = await deps.rasterizer(svg, FRAME);
    scenes.push({
      index: scene.index,
      fromChar: scene.fromChar,
      toChar: scene.toChar,
      slide: { bytes, mimeType: "image/png", width: FRAME.width, height: FRAME.height },
      sourceAssetId: `scene-spec:${scene.index}`,
      sourceAssetChecksum: sceneChecksum(scene),
      motion: sceneMotion(scene.camera),
      captionMode: scene.captionMode,
    });
  }
  return { ok: true, scenes };
};

/**
 * Local providers (Kokoro, ffmpeg) cost nothing per call, but every generation still leaves a
 * ledger row so spend and provenance are queryable per workspace. Ledger failures never fail a
 * render.
 */
const reserveZeroCost = async (
  deps: RenderLongFormDependencies,
  workspaceId: Storyboard["workspaceId"],
  provider: string,
  operation: string,
): Promise<string | null> => {
  if (!deps.costs) return null;
  try {
    const event = await deps.costs.create(
      reserveCost({ workspaceId, provider, operation, estimatedMinor: 0, currency: "USD" }),
    );
    return event.id;
  } catch {
    return null;
  }
};
const settleZeroCost = async (
  deps: RenderLongFormDependencies,
  workspaceId: Storyboard["workspaceId"],
  id: string | null,
): Promise<void> => {
  if (!deps.costs || !id) return;
  try {
    await deps.costs.settle({ workspaceId, id, actualMinor: 0 });
  } catch {
    // Ledger is best-effort for zero-cost local providers.
  }
};
