import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import {
  STYLE_FRAME_CAST,
  STYLE_FRAME_SHOTS,
  styleFrameStoryboard,
  styleFrameTiming,
} from "@money-maker/core/explainer/fixtures/style-frames/fixtures";
import { composeMotionFrame, VIGNETTE_MASK_SVG } from "@money-maker/core/explainer/motion/frame";
import { type MotionSceneTiming, planMotion } from "@money-maker/core/explainer/motion/plan";
import { configureBundledFonts } from "./fonts.js";
import { applyVignette } from "./stickman-motion-renderer.js";

/**
 * B2 correctness gate (v2 slice 17): the cached-vignette path against the full-frame path on a
 * golden set; spec bar ≤ 1% of pixels differing by more than 8/255.
 */
const raster = (svg: string) =>
  sharp(Buffer.from(svg), { density: 72 }).removeAlpha().raw().toBuffer();

const diffShare = (a: Buffer, b: Buffer): Readonly<{ share: number; max: number }> => {
  let bad = 0;
  let max = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs((a[i] ?? 0) - (b[i] ?? 0)),
      Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)),
      Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)),
    );
    if (d > 8) bad += 1;
    max = Math.max(max, d);
  }
  return { share: bad / (a.length / 3), max };
};

describe("layer cache parity (golden set)", () => {
  configureBundledFonts();
  const { scenes } = styleFrameStoryboard();
  // The whole fixture storyboard on one timeline, so fades and wipes between scenes are covered.
  let cursor = 0;
  const timings: MotionSceneTiming[] = STYLE_FRAME_SHOTS.map((shot) => {
    const local = styleFrameTiming(shot);
    const shift = (ms: number) => ms + cursor;
    const timing = {
      ...local,
      startMs: shift(local.startMs),
      endMs: shift(local.endMs),
      voiceStartMs: shift(local.voiceStartMs),
      voiceEndMs: shift(local.voiceEndMs),
      words: local.words.map((word) => ({
        ...word,
        startMs: shift(word.startMs),
        endMs: shift(word.endMs),
      })),
    };
    cursor += shot.durationMs;
    return timing;
  });
  const plate = sharp({
    create: { width: 768, height: 1344, channels: 3, background: "#6b8fb3" },
  })
    .jpeg()
    .toBuffer();
  const golden = async () => {
    const art = new Map([
      ["plate", { href: `data:image/jpeg;base64,${(await plate).toString("base64")}` }],
    ]);
    const painted = scenes.map((scene, i) =>
      i === 7 ? { ...scene, backgroundAssetId: "plate" } : scene,
    );
    const plan = planMotion({
      scenes: painted,
      timings,
      characters: STYLE_FRAME_CAST,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: cursor,
      backgroundArt: art,
    });
    const at = (index: number, offset: number) => (timings[index]?.startMs ?? 0) + offset;
    // single hero, expression close, wide establishing, hero+prop+number, dialogue,
    // painted plate, a fade and a wipe mid-transition.
    return {
      plan,
      times: [
        at(0, 1_400),
        at(4, 1_400),
        at(9, 1_400),
        at(10, 2_000),
        at(12, 2_200),
        at(7, 1_500),
        at(9, 120),
        at(13, 150),
      ],
    };
  };

  it("keeps every golden frame within 1% of pixels over 8/255 (measured: identical)", async () => {
    const mask = await sharp(Buffer.from(VIGNETTE_MASK_SVG), { density: 72 })
      .removeAlpha()
      .extractChannel(0)
      .raw()
      .toBuffer();
    const { plan, times } = await golden();
    for (const t of times) {
      const full = await raster(composeMotionFrame(plan, t));
      const cached = applyVignette(
        await raster(composeMotionFrame(plan, t, { vignette: false })),
        mask,
      );
      const { share, max } = diffShare(full, cached);
      expect(share).toBeLessThanOrEqual(0.01);
      expect(max).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it("leaves the default composition unchanged", async () => {
    const { plan, times } = await golden();
    const t = times[0] ?? 0;
    expect(composeMotionFrame(plan, t, {})).toBe(composeMotionFrame(plan, t));
    expect(composeMotionFrame(plan, t, { vignette: false })).not.toContain(
      'url(#mm-vignette)"/></svg>',
    );
  });
});
