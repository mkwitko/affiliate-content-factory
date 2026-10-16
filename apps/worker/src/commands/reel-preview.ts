import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReelRenderer } from "@money-maker/core/assets/reel-renderer";
import { buildReelTimeline, type ReelClip } from "@money-maker/core/assets/reel-timeline";
import type { SpeechSynthesizer } from "@money-maker/core/assets/speech-synthesizer";
import { createSpokenTextSynthesizer } from "@money-maker/core/assets/spoken-text";
import { resolveNicheCaptionTheme } from "@money-maker/core/brand/caption-style";
import { qualitySummary } from "@money-maker/core/publishing/render-quality";
import { createFfmpegReelRenderer } from "@money-maker/providers/media/ffmpeg-reel-renderer";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";

/**
 * Previews finished Reels as 5-beat stories with the niche's recurring character: hook problem,
 * the problem gets worse, the character finds the product, the result, then the offer slide
 * (the feed post with the price and "Link na bio"). Production path: spoken-form Kokoro
 * narration, word-timed `boxed` captions and the ffmpeg reel renderer (same inputs as
 * render_reel). Frames come from post-preview (`<case>.reel.jpg`, speech bubble included).
 * `--music=<file>` mixes a track under the voice (sidechain ducking, fade in and out, done by
 * the renderer); the owner picks the file and it must be royalty-free for commercial use.
 * The lines are PREVIEW copy; the only price is the offer line, equal to the slide price.
 */
export const BEATS = ["problem", "problem2", "discovery", "result", "feed"] as const;

type ReelPlan = Readonly<{
  voiceId: string;
  lines: readonly [string, string, string, string, string];
}>;

export const REEL_PLANS: Readonly<Record<string, ReelPlan>> = {
  casa: {
    voiceId: "pf_dora",
    lines: [
      "Sabe quando a toalha não tem onde ficar?",
      "Aí vai tudo parar em cima da pia.",
      "Foi aí que a Carla achou essa estante.",
      "Três prateleiras, e o banheiro em ordem.",
      "De R$ 52,90 por R$ 36,85. Link na bio.",
    ],
  },
  beleza: {
    voiceId: "pf_dora",
    lines: [
      "Sabe quando a maquiagem toma a bancada?",
      "E o batom some bem na hora de sair.",
      "Aí a Bia achou esse organizador de acrílico.",
      "Com gavetas, tudo à vista e no lugar.",
      "De R$ 78,99 por R$ 48,99. Link na bio.",
    ],
  },
  tech: {
    voiceId: "pm_alex",
    lines: [
      "Sabe quando o fio enrosca na chamada?",
      "E ainda puxa o celular da mesa.",
      "Foi aí que o Rafa achou esse fone sem fio.",
      "Agora ele conversa andando pela sala.",
      "Por R$ 29,99. Link na bio.",
    ],
  },
};

/** Each beat holds at least this long; with short lines that is 3-4 s a beat. */
const MIN_BEAT_SEC = 3;
const TARGET_TOTAL_SEC = 20;

// Same shape the niche context stores (readCaptionThemeConfig).
const NICHE = { context: { captionTheme: { preset: "boxed" } } } as const;
const SLIDE_SIDE = { width: 1080, height: 1350 } as const;

export type ReelPreviewOptions = Readonly<{
  inDir: string;
  outDir: string;
  synthesizer: SpeechSynthesizer;
  renderer: ReelRenderer;
  /** Background track; absent renders voice only. */
  musicFile?: string;
  log?: (line: string) => void;
}>;

export type ReelSummary = Readonly<{
  niche: string;
  file: string;
  durationMs: number;
  bytes: number;
  voiceId: string;
  quality: ReturnType<typeof qualitySummary> | null;
}>;

export const runReelPreview = async (
  options: ReelPreviewOptions,
): Promise<{ reels: ReelSummary[]; skipped: string[] }> => {
  const log = options.log ?? console.log;
  const postsDir = join(options.inDir, "posts");
  await mkdir(options.outDir, { recursive: true });
  const reels: ReelSummary[] = [];
  const skipped: string[] = [];
  for (const [niche, plan] of Object.entries(REEL_PLANS)) {
    const images = await Promise.all(
      BEATS.map((part) =>
        readFile(join(postsDir, `${niche}_${part}.reel.jpg`))
          .catch(() => readFile(join(postsDir, `${niche}_${part}.jpg`)))
          .catch(() => null),
      ),
    );
    const found: Buffer[] = [];
    for (const bytes of images) if (bytes) found.push(bytes);
    if (found.length !== BEATS.length) {
      skipped.push(niche);
      log(`skipped ${niche}: needs ${BEATS.map((p) => `${niche}_${p}.jpg`).join(", ")}`);
      continue;
    }
    const clips: ReelClip[] = [];
    const voiceClips: Uint8Array[] = [];
    for (const text of plan.lines) {
      const clip = await options.synthesizer.synthesize({
        text,
        voiceId: plan.voiceId,
        language: "pt-BR",
      });
      clips.push({ durationMs: clip.durationMs, words: clip.words });
      voiceClips.push(clip.bytes);
    }
    const timeline = buildReelTimeline({
      slideCount: found.length,
      clips,
      minSlideSec: MIN_BEAT_SEC,
      ...(options.renderer.crossfadeSec !== undefined
        ? { crossfadeSec: options.renderer.crossfadeSec }
        : {}),
    });
    if (timeline.totalSec >= TARGET_TOTAL_SEC)
      log(`${niche}: ${timeline.totalSec} s, over the ${TARGET_TOTAL_SEC} s target; shorten lines`);
    const captionTheme = resolveNicheCaptionTheme({ niche: NICHE, canvas: "portrait" });
    const output = await options.renderer.render({
      slides: found.map((bytes) => ({ bytes, mimeType: "image/jpeg", ...SLIDE_SIDE })),
      timeline,
      voiceClips,
      ...(options.musicFile ? { musicFile: options.musicFile } : {}),
      ...(captionTheme ? { captionStyle: { theme: captionTheme } } : {}),
    });
    const file = join(options.outDir, `${niche}.mp4`);
    await writeFile(file, output.bytes);
    const summary: ReelSummary = {
      niche,
      file,
      durationMs: output.durationMs,
      bytes: output.bytes.byteLength,
      voiceId: plan.voiceId,
      quality: output.quality ? qualitySummary(output.quality) : null,
    };
    reels.push(summary);
    log(
      `wrote ${file} (${Math.round(output.durationMs / 100) / 10} s, ${summary.quality?.verdict ?? "no QA"})`,
    );
  }
  await writeFile(
    join(options.outDir, "summary.json"),
    JSON.stringify({ reels, skipped }, null, 2),
  );
  log(`done: ${reels.length} reels, ${skipped.length} skipped (${skipped.join(", ") || "none"})`);
  return { reels, skipped };
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (process.argv[1]?.endsWith("reel-preview.js")) {
  const args = process.argv.slice(2);
  const inDir = flag(args, "in") ?? "edit-bench-out";
  const musicFile = flag(args, "music");
  void (musicFile ? access(musicFile) : Promise.resolve())
    .catch(() => {
      throw new Error(`music file not found: ${musicFile}`);
    })
    .then(() =>
      runReelPreview({
        inDir,
        outDir: flag(args, "out") ?? join(inDir, "reels"),
        synthesizer: createSpokenTextSynthesizer(
          createKokoroSpeechSynthesizer({
            baseUrl: process.env["TTS_URL"] ?? "http://127.0.0.1:8880",
          }),
        ),
        // --edit=v2 previews the content-generation reel engine (eased motion, inner cuts).
        renderer: createFfmpegReelRenderer(flag(args, "edit") === "v2" ? { editStyle: "v2" } : {}),
        ...(musicFile ? { musicFile } : {}),
      }),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "reel preview failed");
      process.exitCode = 1;
    });
}
