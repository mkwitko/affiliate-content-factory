import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { meanFrameDiff, probeVideo, renderStaticZoomClip, transcodeToMp4 } from "./clip-video.js";

const makeWebm = (width: number, height: number, frames: number): Uint8Array => {
  const dir = mkdtempSync(join(tmpdir(), "clip-video-test-"));
  try {
    const out = join(dir, "t.webm");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${width}x${height}:rate=16`,
      "-frames:v",
      String(frames),
      "-c:v",
      "libvpx",
      out,
    ]);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("clip video helpers", () => {
  it("probes a decodable webm and transcodes it to a same-size h264 mp4", async () => {
    const webm = makeWebm(480, 832, 17);
    const probe = await probeVideo(webm, "video/webm");
    expect(probe).toMatchObject({
      readable: true,
      hasVideo: true,
      width: 480,
      height: 832,
      frameCount: 17,
      decodeErrors: 0,
    });
    expect(probe.durationMs).toBeGreaterThan(0);
    const mp4 = await transcodeToMp4(webm, "video/webm");
    expect(await probeVideo(mp4, "video/mp4")).toMatchObject({
      width: 480,
      height: 832,
      frameCount: 17,
    });
  }, 60_000);

  it("measures a frame-difference proxy and returns null for unusable input", async () => {
    expect(await meanFrameDiff(makeWebm(160, 160, 8), "video/webm")).toBeGreaterThan(0);
    expect(await meanFrameDiff(new Uint8Array([1, 2]), "video/webm")).toBeNull();
  }, 60_000);

  it("reports corrupt bytes as unreadable instead of throwing", async () => {
    expect((await probeVideo(new Uint8Array([1, 2, 3, 4, 5]), "video/webm")).readable).toBe(false);
    expect((await probeVideo(new Uint8Array([1]), "image/png")).readable).toBe(false);
  });

  it("flags a truncated stream as erroring or short", async () => {
    const webm = makeWebm(480, 832, 17);
    const probe = await probeVideo(webm.slice(0, Math.floor(webm.length / 2)), "video/webm");
    expect(!probe.readable || probe.decodeErrors > 0 || probe.frameCount < 17).toBe(true);
  }, 60_000);

  it("renders a still plate as a zoom clip of the requested size and length", async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 400, height: 300, channels: 3, background: "#3366cc" } })
        .png()
        .toBuffer(),
    );
    const clip = await renderStaticZoomClip({ image: png, width: 360, height: 640, seconds: 2 });
    expect(await probeVideo(clip, "video/mp4")).toMatchObject({
      width: 360,
      height: 640,
      frameCount: 50,
      decodeErrors: 0,
    });
  }, 60_000);
});
