import type { RenderStats, TimeRange } from "@money-maker/core/publishing/render-quality";
import { runProcess } from "./run-process.js";

export type VideoQualityProbeOptions = Readonly<{
  signal?: AbortSignal | undefined;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Kills either process past this many ms. Default 3 minutes (a 15-minute long-form). */
  timeoutMs?: number;
}>;

type Analysis = Readonly<{
  silences: readonly TimeRange[];
  blacks: readonly TimeRange[];
  freezes: readonly TimeRange[];
  integratedLufs?: number;
  truePeakDbtp?: number;
  decodeErrors: number;
}>;

const ms = (seconds: string) => Math.round(Number.parseFloat(seconds) * 1000);
const DETECTOR_TAG = /^\[(silencedetect|blackdetect|freezedetect|Parsed_|out#|fc#|vist#|aost#)/;

/** Pure: turns the analysis pass's stderr into intervals; exported for tests. */
export const parseAnalysisLog = (log: string, durationMs: number): Analysis => {
  const silences: TimeRange[] = [];
  const blacks: TimeRange[] = [];
  const freezes: TimeRange[] = [];
  let silenceStart: number | undefined;
  let freezeStart: number | undefined;
  let integratedLufs: number | undefined;
  let truePeakDbtp: number | undefined;
  let decodeErrors = 0;
  let inSummary = false;
  for (const line of log.split("\n")) {
    const silenceOpen = line.match(/silence_start: (-?[\d.]+)/);
    if (silenceOpen?.[1]) silenceStart = Math.max(0, ms(silenceOpen[1]));
    const silenceClose = line.match(/silence_end: ([\d.]+)/);
    if (silenceClose?.[1] && silenceStart !== undefined) {
      silences.push({ startMs: silenceStart, endMs: Math.min(durationMs, ms(silenceClose[1])) });
      silenceStart = undefined;
    }
    const black = line.match(/black_start:([\d.]+) black_end:([\d.]+)/);
    if (black?.[1] && black[2]) blacks.push({ startMs: ms(black[1]), endMs: ms(black[2]) });
    const freezeOpen = line.match(/freeze_start: ([\d.]+)/);
    if (freezeOpen?.[1]) freezeStart = ms(freezeOpen[1]);
    const freezeClose = line.match(/freeze_end: ([\d.]+)/);
    if (freezeClose?.[1] && freezeStart !== undefined) {
      freezes.push({ startMs: freezeStart, endMs: ms(freezeClose[1]) });
      freezeStart = undefined;
    }
    if (/Summary:/.test(line)) inSummary = true;
    const integrated = inSummary ? line.match(/^\s+I:\s+(-?[\d.]+) LUFS/) : null;
    if (integrated?.[1]) integratedLufs = Number.parseFloat(integrated[1]);
    const peak = inSummary ? line.match(/^\s+Peak:\s+(-?[\d.]+|-inf) dBFS/) : null;
    if (peak?.[1]) truePeakDbtp = peak[1] === "-inf" ? -120 : Number.parseFloat(peak[1]);
    if (/^\[[^\]]+\]/.test(line) && !DETECTOR_TAG.test(line) && /error|corrupt|invalid/i.test(line))
      decodeErrors += 1;
  }
  if (silenceStart !== undefined) silences.push({ startMs: silenceStart, endMs: durationMs });
  if (freezeStart !== undefined) freezes.push({ startMs: freezeStart, endMs: durationMs });
  return {
    silences,
    blacks,
    freezes,
    ...(integratedLufs !== undefined ? { integratedLufs } : {}),
    ...(truePeakDbtp !== undefined ? { truePeakDbtp } : {}),
    decodeErrors,
  };
};

type ProbeStream = Readonly<{
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
}>;

const fps = (rate: string | undefined): number => {
  const [num, den] = (rate ?? "0/1").split("/").map(Number);
  return num && den ? Math.round((num / den) * 100) / 100 : 0;
};

const isAbort = (error: unknown) => error instanceof Error && error.message === "render_aborted";

/**
 * Measures a rendered MP4 with ffprobe (streams, duration) and one ffmpeg pass on a 540x960
 * downscale (black, freeze, silence, EBU R128 loudness and true peak). Both processes take
 * argument arrays, the caller's signal and a timeout. An unreadable file is reported, not thrown.
 */
export const measureRenderedVideo = async (
  path: string,
  options: VideoQualityProbeOptions = {},
): Promise<RenderStats> => {
  const { signal } = options;
  if (signal?.aborted) throw new Error("render_aborted");
  const timeout = options.timeoutMs ?? 180_000;
  const unreadable: RenderStats = {
    readable: false,
    decodeErrors: 0,
    hasAudio: false,
    durationMs: 0,
    silences: [],
    blacks: [],
    freezes: [],
  };
  let probe: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    const { stdout } = await runProcess(
      options.ffprobePath ?? "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { timeoutMs: timeout, maxBuffer: 4 * 1024 * 1024, signal },
    );
    probe = JSON.parse(stdout) as typeof probe;
  } catch (error) {
    if (isAbort(error)) throw new Error("render_aborted");
    return unreadable;
  }
  const streams = probe.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const durationMs = ms(probe.format?.duration ?? "0");
  if (!videoStream) return { ...unreadable, readable: true, hasAudio, durationMs };
  const filter = [
    "[0:v]scale=540:960,blackdetect=d=0.3:pic_th=0.98:pix_th=0.10,freezedetect=n=-60dB:d=2[vo]",
    ...(hasAudio ? ["[0:a]silencedetect=n=-50dB:d=0.8,ebur128=peak=true[ao]"] : []),
  ].join(";");
  let log: string;
  try {
    const result = await runProcess(
      options.ffmpegPath ?? "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-v",
        "info",
        "-i",
        path,
        "-filter_complex",
        filter,
        "-map",
        "[vo]",
        ...(hasAudio ? ["-map", "[ao]"] : []),
        "-f",
        "null",
        "-",
      ],
      // ebur128 logs a line per 100 ms; 32 MB of stderr tail covers a 15-minute render.
      { timeoutMs: timeout, maxBuffer: 32 * 1024 * 1024, signal },
    );
    log = result.stderr;
  } catch (error) {
    if (isAbort(error)) throw new Error("render_aborted");
    return { ...unreadable, readable: true, hasAudio, durationMs, decodeErrors: 1 };
  }
  const analysis = parseAnalysisLog(log, durationMs);
  return {
    readable: true,
    decodeErrors: analysis.decodeErrors,
    video: {
      codec: videoStream.codec_name ?? "unknown",
      pixelFormat: videoStream.pix_fmt ?? "unknown",
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      fps: fps(videoStream.r_frame_rate),
    },
    hasAudio,
    durationMs,
    ...(analysis.integratedLufs !== undefined ? { integratedLufs: analysis.integratedLufs } : {}),
    ...(analysis.truePeakDbtp !== undefined ? { truePeakDbtp: analysis.truePeakDbtp } : {}),
    silences: analysis.silences,
    blacks: analysis.blacks,
    freezes: analysis.freezes,
  };
};
