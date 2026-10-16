import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  blendOverlay,
  KEN_BURNS_MOTION,
  PARALLAX_MOTION,
  parallaxFrame,
  parallaxMotionFor,
  type RawImage,
  renderParallaxSlide,
} from "./parallax-clip.js";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const w = 64;
const h = 48;
// A horizontal gradient scene, so a sampled colour tells where a pixel came from.
const scene: RawImage = {
  width: w,
  height: h,
  data: Uint8Array.from({ length: w * h * 3 }, (_, i) => Math.round(((i / 3) % w) * 4)),
};
// Near (white) left half, far (black) right half.
const depth: RawImage = {
  width: w,
  height: h,
  data: Uint8Array.from({ length: w * h }, (_, i) => (i % w < w / 2 ? 255 : 0)),
};
const flat: RawImage = { ...depth, data: new Uint8Array(w * h).fill(128) };
const frame = (d: RawImage, motion: typeof PARALLAX_MOTION, t: number) => {
  const out = new Uint8Array(w * h * 3);
  parallaxFrame(scene, d, motion, t, out);
  return out;
};
const red = (out: Uint8Array, x: number, y: number) => out[(y * w + x) * 3] as number;

describe("parallaxFrame", () => {
  it("is plain Ken Burns when shift and dolly are 0, whatever the depth", () => {
    for (const t of [0, 0.5, 1])
      expect(frame(depth, KEN_BURNS_MOTION, t)).toEqual(frame(flat, KEN_BURNS_MOTION, t));
  });

  it("moves near pixels against far ones over the clip", () => {
    const start = frame(depth, PARALLAX_MOTION, 0);
    const end = frame(depth, PARALLAX_MOTION, 1);
    const kbStart = frame(depth, KEN_BURNS_MOTION, 0);
    const kbEnd = frame(depth, KEN_BURNS_MOTION, 1);
    // Sampled source column change at a near (x=8) and a far (x=56) pixel, beyond Ken Burns.
    const nearMove =
      red(end, 8, 24) - red(start, 8, 24) - (red(kbEnd, 8, 24) - red(kbStart, 8, 24));
    const farMove =
      red(end, 56, 24) - red(start, 56, 24) - (red(kbEnd, 56, 24) - red(kbStart, 56, 24));
    expect(Math.sign(nearMove)).not.toBe(Math.sign(farMove));
    expect(Math.abs(nearMove - farMove)).toBeGreaterThan(4);
  });

  it("stays inside the scene: no black border at the corners", () => {
    for (const t of [0, 1]) {
      const out = frame(depth, PARALLAX_MOTION, t);
      expect(red(out, w - 1, 0)).toBeGreaterThan(200);
      expect(red(out, 0, h - 1)).toBeLessThan(20);
    }
  });
});

describe("blendOverlay", () => {
  it("keeps the frame where the overlay is transparent and mixes by alpha elsewhere", () => {
    const frame = Uint8Array.from([100, 100, 100, 100, 100, 100]);
    const rgba = Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 128]);
    blendOverlay(frame, rgba, Uint32Array.from([1]));
    expect([...frame]).toEqual([100, 100, 100, 178, 178, 178]);
  });
});

describe("parallaxMotionFor", () => {
  it("alternates direction and zoom between consecutive slides", () => {
    expect(parallaxMotionFor(0)).toEqual(PARALLAX_MOTION);
    expect(parallaxMotionFor(1)).toMatchObject({
      shift: -PARALLAX_MOTION.shift,
      zoomFrom: PARALLAX_MOTION.zoomTo,
      zoomTo: PARALLAX_MOTION.zoomFrom,
    });
  });
});

describe.skipIf(!hasFfmpeg)("renderParallaxSlide", () => {
  it("returns a 1080x1920 MP4 of a 4:5 slide with its still text layer", async () => {
    const png = (channels: 3 | 4, colour: number) =>
      sharp({
        create: {
          width: 108,
          height: 135,
          channels,
          background: { r: colour, g: colour, b: colour, alpha: 0.5 },
        },
      })
        .png()
        .toBuffer()
        .then((bytes) => new Uint8Array(bytes));
    const mp4 = await renderParallaxSlide({
      scene: await png(3, 200),
      depth: await png(3, 128),
      overlay: await png(4, 255),
      width: 108,
      height: 135,
      index: 0,
      durationSec: 0.2,
    });
    expect(Buffer.from(mp4.subarray(4, 8)).toString()).toBe("ftyp");
  });
});
