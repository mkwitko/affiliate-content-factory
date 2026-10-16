import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import type { ImageSegmenter, Segmentation } from "@money-maker/core/creatives/canonical-product";
import { runProcess } from "./run-process.js";

/**
 * Parses SEGMENTER_CMD: a whitespace-separated argv (no shell, no quoting) that must contain the
 * `{input}` and `{output}` placeholders, e.g.
 * `rembg i -m isnet-general-use -om {input} {output}`. rembg's default model is BRIA RMBG, whose
 * licence forbids unpaid commercial use, so a rembg command must name its model explicitly and
 * no BRIA model is accepted.
 */
// ponytail: whitespace split, so paths with spaces are unsupported; point at a wrapper script if needed.
export const parseSegmenterCommand = (command: string): readonly string[] => {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (argv.length < 3 || !argv.includes("{input}") || !argv.includes("{output}"))
    throw new Error("segmenter_cmd_invalid");
  if (argv.some((arg) => /bria/i.test(arg))) throw new Error("segmenter_model_not_licensed");
  if (
    basename(argv[0] ?? "") === "rembg" &&
    !argv.some((arg) => arg === "-m" || arg === "--model" || arg.startsWith("--model="))
  )
    throw new Error("segmenter_model_required");
  return argv;
};

/**
 * Confidence is the share of mask pixels that are decisive (near 0 or 255): soft, grey masks mean
 * the model was unsure. bbox covers pixels at or above 128, in mask pixels.
 */
export const maskStats = (
  values: Uint8Array,
  width: number,
  height: number,
): Pick<Segmentation, "bbox" | "confidence"> => {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let decisive = 0;
  for (let index = 0; index < width * height; index += 1) {
    const value = values[index] ?? 0;
    if (value <= 25 || value >= 230) decisive += 1;
    if (value < 128) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < 0
    ? { bbox: { x: 0, y: 0, w: 0, h: 0 }, confidence: 0 }
    : {
        bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        confidence: width * height ? decisive / (width * height) : 0,
      };
};

export const createCommandImageSegmenter = (
  options: Readonly<{ command: string; timeoutMs?: number; tempRoot?: string }>,
): ImageSegmenter => {
  const argv = parseSegmenterCommand(options.command);
  return {
    segment: async ({ bytes }) => {
      const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), "segment-"));
      try {
        const input = join(dir, "input.png");
        const output = join(dir, "mask.png");
        // EXIF-rotate first so the mask lines up with applyMask, which also rotates.
        await writeFile(input, await sharp(bytes).rotate().png().toBuffer());
        const [command = "", ...args] = argv.map((arg) =>
          arg === "{input}" ? input : arg === "{output}" ? output : arg,
        );
        await runProcess(command, args, { timeoutMs: options.timeoutMs ?? 120_000 });
        const maskPng = new Uint8Array(await readFile(output));
        const { data, info } = await sharp(maskPng)
          .removeAlpha()
          .toColourspace("b-w")
          .raw()
          .toBuffer({ resolveWithObject: true });
        return { maskPng, ...maskStats(new Uint8Array(data), info.width, info.height) };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
