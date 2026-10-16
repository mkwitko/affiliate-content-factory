import { describe, expect, it } from "vitest";
import { createStageTimer, summarizeTimings } from "./stage-timer.js";

const clock = (ticks: number[]) => {
  let i = 0;
  return () => {
    const value = ticks[i] ?? ticks[ticks.length - 1] ?? 0;
    i += 1;
    return value;
  };
};

describe("createStageTimer", () => {
  it("accumulates one high-resolution reading per stage call", () => {
    const timer = createStageTimer(clock([0, 5, 5, 12, 20, 21]));
    timer.mark("compose");
    timer.stop("compose"); // 5
    timer.mark("raster");
    timer.stop("raster"); // 7
    timer.mark("compose");
    timer.stop("compose"); // 1
    expect(timer.read()).toEqual({ compose: 6, raster: 7 });
  });

  it("times an async stage from its start to its settlement", async () => {
    const timer = createStageTimer(clock([100, 130.5]));
    const value = await timer.time("encode", async () => "ok");
    expect(value).toBe("ok");
    expect(timer.read()).toEqual({ encode: 30.5 });
  });

  it("keeps the stage total when the timed work throws", async () => {
    const timer = createStageTimer(clock([0, 9]));
    await expect(
      timer.time("mix", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(timer.read()).toEqual({ mix: 9 });
  });

  it("refuses to stop a stage that was not started", () => {
    const timer = createStageTimer(clock([0]));
    expect(() => timer.stop("compose")).toThrow("stage_timer_not_started");
  });
});

describe("summarizeTimings", () => {
  it("rounds to a tenth of a millisecond and derives the frame rate from the frame path", () => {
    expect(
      summarizeTimings({
        frames: 90,
        stages: { compose: 100.04, raster: 1200.06, write: 50, encode: 650, mix: 300, qa: 200 },
        totalMs: 2600.5,
      }),
    ).toEqual({
      frames: 90,
      composeMs: 100,
      rasterMs: 1200.1,
      writeMs: 50,
      encodeMs: 650,
      concatMs: 0,
      chunks: 1,
      mixMs: 300,
      qaMs: 200,
      totalMs: 2600.5,
      framesPerSec: 45,
    });
  });

  it("reports zero frames per second when nothing was timed", () => {
    expect(summarizeTimings({ frames: 0, stages: {}, totalMs: 0 }).framesPerSec).toBe(0);
  });
});
