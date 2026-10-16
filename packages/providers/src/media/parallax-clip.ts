import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runProcess } from "./run-process.js";
import { writeFrame } from "./stickman-motion-renderer.js";

/**
 * 2.5D parallax (motion tier parallax_2_5d): one still scene plus its relative depth map
 * (scripts/local-ai/depth.py, white = near) becomes a short clip in which near things move more
 * than far ones, on top of the same eased zoom as Ken Burns. With `shift` and `dolly` at 0 the
 * clip is plain Ken Burns, so both arms of the motion arena share one renderer and one encoder.
 *
 * Each output pixel samples the scene backwards: zoom about the centre, a per-depth zoom (the
 * dolly, near pixels grow), and a horizontal per-depth offset (the camera slides). The depth that
 * drives a pixel is read at its source position, refined once, and the map is blurred first, so
 * object edges stretch a little instead of tearing.
 */
export type ParallaxMotion = Readonly<{
  zoomFrom: number;
  zoomTo: number;
  /** Camera slide over the whole clip, as a share of the width (near vs far relative travel). */
  shift: number;
  /** Extra zoom of the nearest pixels over the clip (0.06 = 6 %). */
  dolly: number;
}>;

export const KEN_BURNS_MOTION: ParallaxMotion = { zoomFrom: 1.04, zoomTo: 1.1, shift: 0, dolly: 0 };
export const PARALLAX_MOTION: ParallaxMotion = {
  zoomFrom: 1.04,
  zoomTo: 1.1,
  shift: 0.04,
  dolly: 0.06,
};
/** Half the depth motion: round 2 of the motion arena looks for the right strength. */
export const PARALLAX_SOFT_MOTION: ParallaxMotion = {
  zoomFrom: 1.04,
  zoomTo: 1.1,
  shift: 0.02,
  dolly: 0.03,
};

export type RawImage = Readonly<{ width: number; height: number; data: Uint8Array }>;

/** Cosine ease-in-out, 0..1. */
const ease = (t: number) => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2;

/**
 * Writes one RGB frame at clip progress `t` (0..1) into `out`. `scene` is RGB and `depth` grey,
 * both already at the output size.
 */
export const parallaxFrame = (
  scene: RawImage,
  depth: RawImage,
  motion: ParallaxMotion,
  t: number,
  out: Uint8Array,
): void => {
  const { width: w, height: h, data: src } = scene;
  const d = depth.data;
  const e = ease(t);
  const zoom = motion.zoomFrom + (motion.zoomTo - motion.zoomFrom) * e;
  const slide = motion.shift * w * (e - 0.5);
  const dolly = motion.dolly * e;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxX = w - 1.001;
  const maxY = h - 1.001;
  const depthAt = (x: number, y: number) =>
    (d[
      Math.round(Math.min(maxY, Math.max(0, y))) * w + Math.round(Math.min(maxX, Math.max(0, x)))
    ] ?? 0) /
      255 -
    0.5;
  const moving = slide !== 0 || dolly !== 0;
  let o = 0;
  for (let y = 0; y < h; y += 1) {
    const dy = y - cy;
    for (let x = 0; x < w; x += 1) {
      const dx = x - cx;
      let sx = cx + dx / zoom;
      let sy = cy + dy / zoom;
      if (moving)
        for (let pass = 0; pass < 2; pass += 1) {
          const near = depthAt(sx, sy);
          const local = zoom * (1 + dolly * near);
          sx = cx + dx / local + slide * near;
          sy = cy + dy / local;
        }
      sx = Math.min(maxX, Math.max(0, sx));
      sy = Math.min(maxY, Math.max(0, sy));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = (y0 * w + x0) * 3;
      const b = a + 3;
      const c = a + w * 3;
      const e2 = c + 3;
      for (let k = 0; k < 3; k += 1) {
        const top = (src[a + k] as number) * (1 - fx) + (src[b + k] as number) * fx;
        const bottom = (src[c + k] as number) * (1 - fx) + (src[e2 + k] as number) * fx;
        out[o + k] = top * (1 - fy) + bottom * fy + 0.5;
      }
      o += 3;
    }
  }
};

/** Scene and depth cover-cropped to the output size; the depth blurred (about 0.8 % of the width). */
export const prepareParallaxInputs = async (
  sceneBytes: Uint8Array,
  depthBytes: Uint8Array,
  width: number,
  height: number,
): Promise<Readonly<{ scene: RawImage; depth: RawImage }>> => {
  const fit = { width, height, fit: "cover" as const, position: "centre" as const };
  const scene = await sharp(sceneBytes).resize(fit).removeAlpha().raw().toBuffer();
  const depth = await sharp(depthBytes)
    .greyscale()
    .resize(fit)
    .blur(Math.max(0.3, width * 0.008))
    .raw()
    .toBuffer();
  return {
    scene: { width, height, data: new Uint8Array(scene) },
    depth: { width, height, data: new Uint8Array(depth) },
  };
};

export type ParallaxClipInput = Readonly<{
  scene: Uint8Array;
  depth: Uint8Array;
  motion: ParallaxMotion;
  width: number;
  height: number;
  durationSec: number;
  fps?: number;
  ffmpegPath?: string;
  /** Destination mp4 path. */
  outputPath: string;
  timeoutMs?: number;
  /** x264 preset; an intermediate clip that is encoded again can use a faster one. */
  encodePreset?: string;
  /** Still layer drawn over the moving scene every frame (PNG with alpha, width x height). */
  overlay?: Uint8Array;
  /**
   * Final frame size when it differs from the scene (a 4:5 slide in a 9:16 Reel): the slide is
   * centred on a blurred, darkened copy of itself, like the Reel renderer does for still slides.
   */
  canvas?: Readonly<{ width: number; height: number }>;
}>;

/** Alpha-blends a straight-alpha RGBA layer onto an RGB frame, in place. */
export const blendOverlay = (frame: Uint8Array, rgba: Uint8Array, opaque: Uint32Array): void => {
  for (const pixel of opaque) {
    const a = (rgba[pixel * 4 + 3] as number) / 255;
    for (let k = 0; k < 3; k += 1) {
      const at = pixel * 3 + k;
      frame[at] = (frame[at] as number) * (1 - a) + (rgba[pixel * 4 + k] as number) * a + 0.5;
    }
  }
};

/** Renders the clip to `outputPath` (H.264, yuv420p, no audio). */
export const renderParallaxClip = async (input: ParallaxClipInput): Promise<void> => {
  const fps = input.fps ?? 30;
  const frames = Math.max(1, Math.round(input.durationSec * fps));
  const { scene, depth } = await prepareParallaxInputs(
    input.scene,
    input.depth,
    input.width,
    input.height,
  );
  const overlay = input.overlay
    ? new Uint8Array(
        await sharp(input.overlay)
          .resize(input.width, input.height, { fit: "fill" })
          .ensureAlpha()
          .raw()
          .toBuffer(),
      )
    : null;
  const opaque = overlay
    ? Uint32Array.from({ length: input.width * input.height }, (_, i) => i).filter(
        (i) => (overlay[i * 4 + 3] as number) > 0,
      )
    : new Uint32Array();
  const out = input.canvas ?? { width: input.width, height: input.height };
  const left = Math.round((out.width - input.width) / 2);
  const top = Math.round((out.height - input.height) / 2);
  if (left < 0 || top < 0) throw new Error("parallax_canvas_too_small");
  // Backdrop: the still slide (scene + overlay at t=0), blurred and darkened to fill the canvas.
  let backdrop: Buffer | null = null;
  if (left > 0 || top > 0) {
    const still = Buffer.alloc(input.width * input.height * 3);
    parallaxFrame(scene, depth, input.motion, 0, still);
    if (overlay) blendOverlay(still, overlay, opaque);
    backdrop = await sharp(still, {
      raw: { width: input.width, height: input.height, channels: 3 },
    })
      .resize(out.width, out.height, { fit: "cover" })
      .blur(30)
      .modulate({ brightness: 0.55 })
      .removeAlpha()
      .raw()
      .toBuffer();
  }
  let encoder: ChildProcess | undefined;
  const encoding = runProcess(
    input.ffmpegPath ?? "ffmpeg",
    [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${out.width}x${out.height}`,
      "-r",
      String(fps),
      "-i",
      "pipe:0",
      "-c:v",
      "libx264",
      "-preset",
      input.encodePreset ?? "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      input.outputPath,
    ],
    {
      timeoutMs: input.timeoutMs ?? 300_000,
      stdin: "pipe",
      onSpawn: (child) => {
        encoder = child;
        child.stdin?.on("error", () => undefined);
      },
    },
  );
  const encoded = encoding.then(
    () => null,
    (error: unknown) => error,
  );
  try {
    const frame = Buffer.alloc(input.width * input.height * 3);
    const full = backdrop ? Buffer.from(backdrop) : frame;
    const row = input.width * 3;
    for (let i = 0; i < frames; i += 1) {
      parallaxFrame(scene, depth, input.motion, frames === 1 ? 0 : i / (frames - 1), frame);
      if (overlay) blendOverlay(frame, overlay, opaque);
      if (backdrop)
        for (let y = 0; y < input.height; y += 1)
          frame.copy(full, ((top + y) * out.width + left) * 3, y * row, (y + 1) * row);
      if (!encoder) throw new Error("parallax_encoder_closed");
      await writeFrame(encoder, full);
    }
  } finally {
    encoder?.stdin?.end();
  }
  const error = await encoded;
  if (error) throw new Error("parallax_encode_failed");
};

/** Alternates direction and zoom per slide, so consecutive slides do not repeat a move. */
export const parallaxMotionFor = (index: number): ParallaxMotion =>
  index % 2 === 0
    ? PARALLAX_MOTION
    : {
        ...PARALLAX_MOTION,
        shift: -PARALLAX_MOTION.shift,
        zoomFrom: PARALLAX_MOTION.zoomTo,
        zoomTo: PARALLAX_MOTION.zoomFrom,
      };

/**
 * One Reel slide in 2.5D: the scene moves under the still text layer, centred in a 1080x1920
 * frame on a blurred copy of itself. Returns the MP4 bytes.
 */
export const renderParallaxSlide = async (
  input: Readonly<{
    scene: Uint8Array;
    depth: Uint8Array;
    overlay: Uint8Array;
    width: number;
    height: number;
    index: number;
    durationSec: number;
  }>,
): Promise<Uint8Array> => {
  const dir = await mkdtemp(join(tmpdir(), "mm-parallax-"));
  try {
    const outputPath = join(dir, "slide.mp4");
    await renderParallaxClip({
      scene: input.scene,
      depth: input.depth,
      overlay: input.overlay,
      motion: parallaxMotionFor(input.index),
      width: input.width,
      height: input.height,
      canvas: { width: 1080, height: 1920 },
      durationSec: input.durationSec,
      outputPath,
      // The Reel renderer encodes the slide again; the fast preset saves CPU on the server.
      encodePreset: "veryfast",
    });
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
