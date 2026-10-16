/**
 * Pure ffmpeg CLI argument construction: no process spawning, no filesystem access, so this
 * builds and asserts cleanly without a real ffmpeg binary. Each slide is already composed to
 * the exact 1080x1920 output canvas (see ffmpeg-reel-renderer.ts); this only adds the gentle
 * Ken Burns zoom (direction alternates per slide), joins slides with rotating transitions, optionally
 * mixes a synthesized voice-over under ducked background music, burns word-level captions,
 * normalizes voiced audio to -14 LUFS, and adds a music track (looped, faded in and out, lowered
 * under the video) or, without one, a silent AAC track.
 */
export type FfmpegArgsInput = Readonly<{
  slidePaths: readonly string[];
  /**
   * True where the path is an mp4 clip instead of an image: it is looped endlessly, cut at the
   * scene duration and scaled to fill the frame; Ken Burns does not apply to it.
   * ponytail: no ping-pong, a short clip restarts from its first frame.
   */
  videoSlides?: readonly boolean[];
  motions?: readonly ("static" | "ken_burns_in" | "ken_burns_out" | "pan_left" | "pan_right")[];
  /**
   * "v1" (default): linear zoom to 120 %, rotating 0.8 s transitions. "v2" (content-generation
   * reel engine): eased motion (100 -> 105 %, then a cut to a tighter 108 -> 110 % framing inside
   * each image slide longer than V2_SPLIT_MIN_SEC), short fades that read as cuts, no still hold.
   */
  editStyle?: "v1" | "v2";
  outputPath: string;
  /** Seconds each slide holds before the next one crossfades in. Default 4, used when
   * slideDurationsSec is absent. */
  slideDurationSec?: number;
  /** Per-slide duration, seconds; length must equal slidePaths. Overrides slideDurationSec. */
  slideDurationsSec?: readonly number[];
  /** Crossfade length in seconds between consecutive slides. Default 0.8. */
  crossfadeSec?: number;
  /** Output frame rate. Default 30. */
  fps?: number;
  width?: number;
  height?: number;
  /** Background music file; absent means a silent track (unless voice is present). */
  musicPath?: string;
  /** One WAV per slide with the second at which each starts; both arrays align with slidePaths. */
  voice?: Readonly<{ clipPaths: readonly string[]; startSec: readonly number[] }>;
  /** ASS/SSA subtitle file burned into the video with the `subtitles` filter. */
  captionsPath?: string;
  /** Multiplier on the music level; 1 (default) is the original mix. */
  musicGain?: number;
  /** Logo PNG overlaid after captions, inside the platform safe zone. */
  mark?: Readonly<{
    path: string;
    opacity: number;
    position: "top-left" | "top-right" | "bottom-left";
    /** Logo width in pixels. */
    width: number;
    /** Horizontal margin as a fraction of the frame width. */
    safeMargin: number;
  }>;
}>;

export type FfmpegArgsResult = Readonly<{
  args: readonly string[];
  /** Total output duration in seconds, after crossfade overlaps. */
  totalDurationSec: number;
  /** Where zoompan intentionally holds a still frame (static slides, finished zooms), ms. */
  plannedStill: readonly Readonly<{ startMs: number; endMs: number }>[];
}>;

/** Escapes a path for use inside an ffmpeg filtergraph option value (e.g. subtitles=filename=...). */
export const escapeFilterPath = (path: string): string =>
  path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** xfade transitions rotated per slide boundary; all ship with ffmpeg >= 4.3. */
const TRANSITIONS = ["fade", "slideleft", "circleopen", "slideup", "smoothleft"] as const;

/**
 * zoompan rounds its crop box to whole pixels, so a slow zoom steps unevenly (measured: frame
 * steps of 0.65px with 0.47px stdev at 1x). Upscaling first halves that jitter (0.26px).
 */
// ponytail: 2x costs ~1.7x render time (4x: 0.11px jitter but ~3.7x time, near the 180s render timeout)
const ZOOM_UPSCALE = 2;

/** v2 edit: an image slide at least this long is cut into a wide and a tighter shot. */
export const V2_SPLIT_MIN_SEC = 2.4;
/** v2 edit: the wide shot takes this share of the slide, then the tighter framing cuts in. */
const V2_SPLIT_AT = 0.55;
/** v2 edit: a 0.12 s fade reads as a cut and keeps the xfade timeline arithmetic. */
export const V2_TRANSITION_SEC = 0.12;
/** Cosine ease-in-out from 0 to 1 between frames a and b (zoompan `on` is the output frame). */
const ease = (a: number, b: number) => `(1-cos(PI*(on-${a})/${Math.max(1, b - a)}))/2`;

/** zoompan z/x for one v2 image slide of `frames` frames; pans keep a 6 % zoom to stay in frame. */
const v2Motion = (
  motion: "static" | "ken_burns_in" | "ken_burns_out" | "pan_left" | "pan_right",
  frames: number,
  durationSec: number,
): Readonly<{ zoom: string; x: string }> => {
  const centre = "iw/2-(iw/zoom/2)";
  if (motion === "static") return { zoom: "1", x: centre };
  if (motion === "pan_left" || motion === "pan_right") {
    const travel = `(iw-iw/zoom)/2*${ease(0, frames)}`;
    return {
      zoom: "1.06",
      x: motion === "pan_left" ? `${centre}-${travel}` : `${centre}+${travel}`,
    };
  }
  const wide = (from: number, to: number, end: number) =>
    `${from}+${(to - from).toFixed(3)}*${ease(0, end)}`;
  if (durationSec < V2_SPLIT_MIN_SEC)
    return {
      zoom: motion === "ken_burns_in" ? wide(1, 1.08, frames) : wide(1.08, 1, frames),
      x: centre,
    };
  const cut = Math.round(frames * V2_SPLIT_AT);
  const first = motion === "ken_burns_in" ? wide(1, 1.05, cut) : wide(1.05, 1, cut);
  const tight = `1.08+0.02*${ease(cut, frames)}`;
  return { zoom: `if(lt(on,${cut}),${first},${tight})`, x: centre };
};

export const buildFfmpegArgs = (input: FfmpegArgsInput): FfmpegArgsResult => {
  const { slidePaths, outputPath } = input;
  if (slidePaths.length === 0) throw new Error("reel_slide_count_invalid");
  const v2 = input.editStyle === "v2";
  const slideDurationSec = input.slideDurationSec ?? (v2 ? 3 : 4);
  const crossfadeSec = input.crossfadeSec ?? (v2 ? V2_TRANSITION_SEC : 0.8);
  const fps = input.fps ?? 30;
  const width = input.width ?? 1080;
  const height = input.height ?? 1920;

  if (input.motions !== undefined && input.motions.length !== slidePaths.length) {
    throw new Error("reel_motions_invalid");
  }
  if (input.videoSlides !== undefined && input.videoSlides.length !== slidePaths.length) {
    throw new Error("reel_video_slides_invalid");
  }
  const isVideo = (index: number): boolean => input.videoSlides?.[index] === true;
  if (
    input.slideDurationsSec !== undefined &&
    input.slideDurationsSec.length !== slidePaths.length
  ) {
    throw new Error("reel_slide_durations_invalid");
  }
  const durations = input.slideDurationsSec ?? slidePaths.map(() => slideDurationSec);
  if (crossfadeSec >= Math.min(...durations)) {
    throw new Error("reel_crossfade_too_long");
  }

  const inputArgs = slidePaths.flatMap((path, index) => [
    ...(isVideo(index) ? ["-stream_loop", "-1"] : ["-loop", "1"]),
    "-t",
    (durations[index] ?? slideDurationSec).toFixed(3),
    "-i",
    path,
  ]);

  const perSlideFilters = slidePaths.map((_path, index) => {
    if (isVideo(index))
      return `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps},setpts=PTS-STARTPTS,setsar=1[v${index}]`;
    const duration = durations[index] ?? slideDurationSec;
    const frames = Math.max(1, Math.round(duration * fps));
    const motion = input.motions?.[index] ?? (index % 2 === 0 ? "ken_burns_in" : "ken_burns_out");
    if (v2) {
      const { zoom, x } = v2Motion(motion, frames, duration);
      return `[${index}:v]scale=${width * ZOOM_UPSCALE}:${height * ZOOM_UPSCALE}:flags=lanczos,fps=${fps},zoompan=z='${zoom}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},setsar=1[v${index}]`;
    }
    const zoom =
      motion === "static" || motion === "pan_left" || motion === "pan_right"
        ? "1"
        : motion === "ken_burns_in"
          ? "min(1+0.0015*on,1.2)"
          : "max(1.2-0.0015*on,1.0)";
    const x =
      motion === "pan_left"
        ? "iw/2-(iw/zoom/2)-min(on*0.5,iw/8)"
        : motion === "pan_right"
          ? "iw/2-(iw/zoom/2)+min(on*0.5,iw/8)"
          : "iw/2-(iw/zoom/2)";
    return `[${index}:v]scale=${width * ZOOM_UPSCALE}:${height * ZOOM_UPSCALE}:flags=lanczos,fps=${fps},zoompan=z='${zoom}':x='${x}':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=${fps},setsar=1[v${index}]`;
  });

  const plannedStill: { startMs: number; endMs: number }[] = [];
  let slideStart = 0;
  for (const [index, duration] of durations.entries()) {
    if (isVideo(index)) {
      slideStart = slideStart + duration - crossfadeSec;
      continue;
    }
    const motion = input.motions?.[index] ?? (index % 2 === 0 ? "ken_burns_in" : "ken_burns_out");
    // v2 eases over the whole slide, so only a deliberately static slide holds still.
    if (v2 && motion !== "static") {
      slideStart = slideStart + duration - crossfadeSec;
      continue;
    }
    // Mirrors the zoompan expressions above: zooms stop at 0.2/0.0015 frames, pans at iw/8/0.5
    // (iw is the upscaled width); a static slide never moves.
    const movingFrames =
      motion === "static"
        ? 0
        : motion === "ken_burns_in" || motion === "ken_burns_out"
          ? 0.2 / 0.0015
          : (width * ZOOM_UPSCALE) / 8 / 0.5;
    const stillFrom = slideStart + movingFrames / fps;
    const end = slideStart + duration;
    if (stillFrom < end)
      plannedStill.push({ startMs: Math.round(stillFrom * 1000), endMs: Math.round(end * 1000) });
    slideStart = end - crossfadeSec;
  }

  const xfadeFilters: string[] = [];
  let running = durations[0] ?? slideDurationSec;
  let label = "v0";
  for (let index = 1; index < slidePaths.length; index += 1) {
    const isLast = index === slidePaths.length - 1;
    const outLabel = isLast ? "vout" : `vx${index}`;
    const offset = running - crossfadeSec;
    const duration = durations[index] ?? slideDurationSec;
    const transition = v2 ? "fade" : TRANSITIONS[(index - 1) % TRANSITIONS.length];
    xfadeFilters.push(
      `[${label}][v${index}]xfade=transition=${transition}:duration=${crossfadeSec.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`,
    );
    running = running + duration - crossfadeSec;
    label = outLabel;
  }
  const chainVideoLabel = slidePaths.length === 1 ? "v0" : "vout";

  const captionFilter: string[] = [];
  let videoLabel = chainVideoLabel;
  if (input.captionsPath) {
    captionFilter.push(
      `[${chainVideoLabel}]subtitles=filename=${escapeFilterPath(input.captionsPath)}[vcap]`,
    );
    videoLabel = "vcap";
  }

  const audioIndex = slidePaths.length;
  const gain = (base: number): string => String(Number((base * (input.musicGain ?? 1)).toFixed(3)));
  const hasMusic = !!input.musicPath;
  const hasVoice = !!input.voice && input.voice.clipPaths.length > 0;
  // The mark is the last input, after the audio ones (a lone silent track counts as one).
  const audioInputCount =
    hasMusic || hasVoice ? (hasMusic ? 1 : 0) + (input.voice?.clipPaths.length ?? 0) : 1;
  const markIndex = audioIndex + audioInputCount;
  if (input.mark) {
    const { mark } = input;
    // Top positions clear the platform header (13%); bottom-left clears the reserved 20% band.
    const marginX = Math.round(mark.safeMargin * (input.width ?? 1080));
    const marginY = Math.round(
      (input.height ?? 1920) * (mark.position === "bottom-left" ? 0.22 : 0.13),
    );
    const x = mark.position === "top-right" ? `main_w-overlay_w-${marginX}` : String(marginX);
    const y = mark.position === "bottom-left" ? `main_h-overlay_h-${marginY}` : String(marginY);
    captionFilter.push(
      `[${markIndex}:v]format=rgba,scale=${mark.width}:-1,colorchannelmixer=aa=${mark.opacity.toFixed(2)}[mk]`,
      `[${videoLabel}][mk]overlay=${x}:${y}[vmark]`,
    );
    videoLabel = "vmark";
  }

  const voiceBaseIndex = audioIndex + (hasMusic ? 1 : 0);
  const fadeOutSec = Math.min(1.5, running / 2);

  const audioFilters: string[] = [];
  if (hasVoice) {
    const voice = input.voice as NonNullable<FfmpegArgsInput["voice"]>;
    if (voice.clipPaths.length === 1) {
      const startMs = Math.round((voice.startSec[0] ?? 0) * 1000);
      audioFilters.push(`[${voiceBaseIndex}:a]adelay=${startMs}|${startMs}[voice]`);
    } else {
      voice.clipPaths.forEach((_clipPath, index) => {
        const startMs = Math.round((voice.startSec[index] ?? 0) * 1000);
        audioFilters.push(`[${voiceBaseIndex + index}:a]adelay=${startMs}|${startMs}[vd_${index}]`);
      });
      const vdLabels = voice.clipPaths.map((_clipPath, index) => `[vd_${index}]`).join("");
      audioFilters.push(
        `${vdLabels}amix=inputs=${voice.clipPaths.length}:normalize=0:duration=longest[voice]`,
      );
    }

    if (hasMusic) {
      // The voice track is padded with silence before the split: sidechaincompress ends as
      // soon as its shorter input (the sidechain key) hits EOF, so an un-padded voice clip
      // would cut the ducked mix — and the whole `-shortest` output — short right after the
      // last spoken word instead of running for the full reel. -t below still caps the length.
      audioFilters.push("[voice]apad,asplit=2[vkey][vmix]");
      audioFilters.push(`[${audioIndex}:a]volume=${gain(0.5)}[m0]`);
      audioFilters.push(
        "[m0][vkey]sidechaincompress=threshold=0.02:ratio=6:attack=20:release=400[mduck]",
      );
      audioFilters.push("[mduck][vmix]amix=inputs=2:normalize=0:duration=first[amixed]");
      audioFilters.push(
        `[amixed]afade=t=in:d=1,afade=t=out:st=${(running - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}[amaster]`,
      );
    } else {
      // Same reasoning without music: the voice-only track must not end before the last
      // slide does, or -shortest truncates the video to the voice's length.
      audioFilters.push(
        `[voice]apad,afade=t=out:st=${(running - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}[amaster]`,
      );
    }
    // Voiced reels land at the same loudness whatever the Kokoro clip or music track level.
    // -14 LUFS is the usual short-form target; TP -1.5 leaves headroom for AAC overshoot, and
    // single-pass loudnorm upsamples to 192 kHz, hence the aresample back down.
    audioFilters.push("[amaster]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[aout]");
  } else if (hasMusic) {
    audioFilters.push(
      `[${audioIndex}:a]volume=${gain(0.35)},afade=t=in:d=1,afade=t=out:st=${(running - fadeOutSec).toFixed(3)}:d=${fadeOutSec.toFixed(3)}[aout]`,
    );
  }

  const markInputArgs = input.mark ? ["-i", input.mark.path] : [];
  const filterComplex = [
    ...perSlideFilters,
    ...xfadeFilters,
    ...captionFilter,
    ...audioFilters,
  ].join(";");

  const musicInputArgs = hasMusic ? ["-stream_loop", "-1", "-i", input.musicPath as string] : [];
  const voiceInputArgs = hasVoice
    ? (input.voice as NonNullable<FfmpegArgsInput["voice"]>).clipPaths.flatMap((path) => [
        "-i",
        path,
      ])
    : [];
  const audioInputArgs =
    hasMusic || hasVoice
      ? [...musicInputArgs, ...voiceInputArgs]
      : ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"];

  const audioMapLabel = hasMusic || hasVoice ? "[aout]" : `${audioIndex}:a`;

  const args = [
    "-y",
    ...inputArgs,
    ...audioInputArgs,
    ...markInputArgs,
    "-filter_complex",
    filterComplex,
    "-map",
    `[${videoLabel}]`,
    "-map",
    audioMapLabel,
    "-t",
    running.toFixed(3),
    "-r",
    String(fps),
    "-pix_fmt",
    "yuv420p",
    // ffmpeg 7.1+ keeps JPEG slides full range (yuvj420p) unless the output range is set.
    "-color_range",
    "tv",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ];

  return { args, totalDurationSec: running, plannedStill };
};
