import { describe, expect, it } from "vitest";
import { PLATFORM_PRESETS } from "./platform-presets.js";
import { judgeSlideQuality } from "./slide-quality.js";

const feed = PLATFORM_PRESETS.instagram_feed;
const story = PLATFORM_PRESETS.instagram_story;
const base = {
  image: new Uint8Array([1]),
  textColours: { headline: "#111111", cta: "#ffffff" },
};
const ok = async () => 7;
const resultOf = (r: Awaited<ReturnType<typeof judgeSlideQuality>>, id: string) =>
  r.checks.find((c) => c.id === id)?.result;

describe("judgeSlideQuality", () => {
  it("passes a clean slide with score 100", async () => {
    const r = await judgeSlideQuality({
      ...base,
      preset: feed,
      canvas: feed.canvas,
      boxes: {
        headline: { x: 100, y: 100, w: 800, h: 200 },
        cta: { x: 100, y: 1100, w: 400, h: 90 },
      },
      measureContrast: ok,
    });
    expect(r).toMatchObject({ verdict: "pass", score: 100 });
  });

  it("judges measured ink when given and warns when ink leaves its layout box", async () => {
    const r = await judgeSlideQuality({
      ...base,
      preset: feed,
      canvas: feed.canvas,
      boxes: {
        headline: { x: 100, y: 100, w: 800, h: 200 },
        body: { x: 100, y: 400, w: 800, h: 100 },
      },
      // The headline's ink runs far past its box and into the body's box.
      ink: {
        headline: { x: 110, y: 120, w: 900, h: 300 },
        body: { x: 110, y: 400, w: 300, h: 60 },
      },
      measureContrast: ok,
    });
    expect(r.verdict).toBe("warn");
    expect(r.checks.find((c) => c.id === "text_overflow")).toMatchObject({
      result: "warn",
      detail: "headline",
    });
    expect(r.checks.find((c) => c.id === "text_overlap")?.detail).toBe("headline/body");
  });

  it("blocks text outside the canvas", async () => {
    const r = await judgeSlideQuality({
      ...base,
      preset: feed,
      canvas: feed.canvas,
      boxes: { headline: { x: 900, y: 100, w: 400, h: 100 } },
    });
    expect(r.verdict).toBe("block");
    expect(resultOf(r, "in_canvas")).toBe("fail");
    expect(resultOf(r, "contrast")).toBe("n/a");
  });

  it("blocks text in a story uiBlocked band but only warns for the safe area elsewhere", async () => {
    const inBand = await judgeSlideQuality({
      ...base,
      preset: story,
      canvas: story.canvas,
      boxes: { cta: { x: 100, y: 1700, w: 400, h: 90 } },
    });
    expect(resultOf(inBand, "ui_blocked")).toBe("fail");
    expect(inBand.verdict).toBe("block");
    const edge = await judgeSlideQuality({
      ...base,
      preset: feed,
      canvas: feed.canvas,
      boxes: { headline: { x: 10, y: 100, w: 500, h: 100 } },
    });
    expect(edge.verdict).toBe("warn");
    expect(resultOf(edge, "safe_area")).toBe("warn");
  });

  it("warns on overlapping text boxes and subject collisions", async () => {
    const r = await judgeSlideQuality({
      ...base,
      preset: feed,
      canvas: feed.canvas,
      boxes: {
        headline: { x: 100, y: 100, w: 500, h: 200 },
        body: { x: 100, y: 250, w: 500, h: 200 },
      },
      collisions: [{ block: "top", kind: "face", overlap: 0.2 }],
    });
    expect(r.verdict).toBe("warn");
    expect(r.checks.find((c) => c.id === "text_overlap")?.detail).toBe("headline/body");
    expect(r.checks.find((c) => c.id === "subject_collision")?.detail).toBe("top:face");
  });

  it("grades contrast: 4.5 passes, anything lower or unmeasured warns, never blocks", async () => {
    const boxes = { headline: { x: 100, y: 100, w: 500, h: 100 } };
    const run = (measureContrast: () => Promise<number | null>) =>
      judgeSlideQuality({ ...base, preset: feed, canvas: feed.canvas, boxes, measureContrast });
    expect((await run(async () => 4.5)).verdict).toBe("pass");
    expect((await run(async () => 3.5)).verdict).toBe("warn");
    const low = await run(async () => 2.1);
    expect(low.verdict).toBe("warn");
    expect(low.checks.find((c) => c.id === "contrast")?.detail).toBe("headline 2.10");
    expect((await run(async () => null)).verdict).toBe("warn");
    const thrown = await run(async () => {
      throw new Error("boom");
    });
    expect(thrown.verdict).toBe("warn");
  });
});
