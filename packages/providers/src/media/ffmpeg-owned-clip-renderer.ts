import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isVerticalLayout, type ClipRenderer } from "@money-maker/core/assets/clip-renderer";
import type { ReelTimeline } from "@money-maker/core/assets/reel-timeline";
import { buildFocusSendcmd, buildOwnedClipFfmpegArgs } from "./owned-clip-ffmpeg-args.js";
import { buildCaptionAss } from "./reel-captions.js";

const execFileAsync = promisify(execFile);
const maxInputBytes = 250_000_000;
const maxOutputBytes = 100_000_000;

export const createFfmpegOwnedClipRenderer = (options?: {
  ffmpegPath?: string;
  timeoutMs?: number;
}): ClipRenderer => ({
  async render(input) {
    if (
      input.sourceBytes.byteLength === 0 ||
      input.sourceBytes.byteLength > maxInputBytes ||
      !Number.isInteger(input.width) ||
      !Number.isInteger(input.height) ||
      input.width < 1 ||
      input.height < 1
    )
      throw new Error("clip_source_invalid");

    const directory = await mkdtemp(join(tmpdir(), "owned-clip-"));
    const sourcePath = join(directory, "source.mp4");
    const outputPath = join(directory, "clip.mp4");
    const captionsPath = join(directory, "captions.ass");
    try {
      await writeFile(sourcePath, input.sourceBytes);
      const captionAss = input.captionWords?.length
        ? buildCaptionAss(
            {
              slides: [
                {
                  index: 1,
                  startSec: 0,
                  durationSec: (input.endMs - input.startMs) / 1000,
                  voiceStartSec: 0,
                  words: input.captionWords.map((word) => ({
                    text: word.text,
                    startMs: word.startMs,
                    endMs: word.endMs,
                  })),
                },
              ],
              totalSec: (input.endMs - input.startMs) / 1000,
              crossfadeSec: 0,
            } satisfies ReelTimeline,
            input.captionTheme
              ? { theme: input.captionTheme }
              : { fontSize: 56, marginV: 300, groupSize: 3 },
          )
        : null;
      if (captionAss) await writeFile(captionsPath, captionAss, "utf8");
      let focus: { cropWidth: number; initialX: number; commandsPath: string } | undefined;
      if (input.layout === "vertical_focus" && input.focusTrack?.points.length) {
        const commandsPath = join(directory, "focus.cmd");
        const { initialX, text } = buildFocusSendcmd(
          input.focusTrack.points,
          input.startMs,
          input.endMs,
        );
        await writeFile(commandsPath, text, "utf8");
        focus = { cropWidth: input.focusTrack.cropWidth, initialX, commandsPath };
      }
      const args = buildOwnedClipFfmpegArgs({
        inputPath: sourcePath,
        outputPath,
        startMs: input.startMs,
        endMs: input.endMs,
        ...(input.layout ? { layout: input.layout } : {}),
        ...(captionAss ? { captionsPath } : {}),
        ...(focus ? { focus } : {}),
      });
      try {
        await execFileAsync(options?.ffmpegPath ?? "ffmpeg", args, {
          timeout: options?.timeoutMs ?? 120_000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch {
        throw new Error("owned_clip_render_failed");
      }
      const outputSize = (await stat(outputPath)).size;
      if (outputSize <= 0 || outputSize > maxOutputBytes) throw new Error("clip_output_too_large");
      return {
        bytes: new Uint8Array(await readFile(outputPath)),
        mimeType: "video/mp4",
        width: isVerticalLayout(input.layout) ? 1080 : input.width,
        height: isVerticalLayout(input.layout) ? 1920 : input.height,
        durationMs: input.endMs - input.startMs,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
});
