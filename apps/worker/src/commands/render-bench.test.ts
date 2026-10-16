// apps/worker/src/commands/render-bench.test.ts

import { validateSceneSpecs } from "@money-maker/core/explainer/scene-spec";
import { blockReasons } from "@money-maker/core/explainer/visual-qa/tunables";
import { createVisualQa } from "@money-maker/providers/media/frame-metrics";
import { describe, expect, it } from "vitest";
import { BENCH_CAST, benchRow, buildBenchPlan, parseTimeOutput } from "./render-bench.js";

// Output format samples for the parser, not measurements.
const MAC_TIME = `       41.27 real       118.52 user         6.31 sys
          1258291200  maximum resident set size
                   0  average shared memory size
`;
const LINUX_TIME = `	Command being timed: "node render-bench.js render 30 out"
	User time (seconds): 118.52
	System time (seconds): 6.31
	Elapsed (wall clock) time (h:mm:ss or m:ss): 0:41.27
	Maximum resident set size (kbytes): 1228800
`;

describe("buildBenchPlan", () => {
  it.each([
    [30, 7, 29_995],
    [60, 14, 59_990],
  ])("builds a %i s storyboard of %i scenes lasting %i ms", (seconds, scenes, durationMs) => {
    const bench = buildBenchPlan(seconds);
    expect(bench.scenes).toHaveLength(scenes);
    expect(bench.plan.durationMs).toBe(durationMs);
    expect(bench.voiceStartMs).toHaveLength(scenes);
    expect(bench.scenes.some((scene) => (scene.actors[0]?.actions?.length ?? 0) > 0)).toBe(true);
  });

  it("is a storyboard the motion validator accepts", () => {
    const bench = buildBenchPlan(60);
    expect(
      validateSceneSpecs({
        scenes: bench.scenes,
        characters: BENCH_CAST,
        claims: [],
        renderer: "stickman_motion",
        language: "en",
        sceneTexts: bench.texts,
      }),
    ).toEqual({ ok: true });
  });

  it.each([Number.NaN, 30.5, 5, 181])("refuses duration %s", (seconds) => {
    expect(() => buildBenchPlan(seconds)).toThrow("bench_duration_invalid");
  });
});

describe("visual QA compatibility", () => {
  it("lets the render-bench storyboard pass the thumbnail gate", async () => {
    const { plan } = buildBenchPlan(30);
    expect(blockReasons(await createVisualQa().thumbnail(plan))).toEqual([]);
    const section = await createVisualQa().report(plan);
    expect(section.colorStrip).toHaveLength(7);
    expect(blockReasons(section.findings)).toEqual([]);
  }, 60_000);
});

describe("parseTimeOutput", () => {
  it("reads macOS /usr/bin/time -l", () => {
    expect(parseTimeOutput(MAC_TIME)).toEqual({
      wallS: 41.27,
      userS: 118.52,
      sysS: 6.31,
      peakRssMb: 1200,
    });
  });

  it("reads GNU /usr/bin/time -v", () => {
    expect(parseTimeOutput(LINUX_TIME)).toEqual({
      wallS: 41.27,
      userS: 118.52,
      sysS: 6.31,
      peakRssMb: 1200,
    });
  });

  it("reads elapsed times past one hour", () => {
    const text = LINUX_TIME.replace("0:41.27", "1:02:03.45");
    expect(parseTimeOutput(text).wallS).toBeCloseTo(3723.45, 2);
  });

  it("fails loudly on output it does not recognise", () => {
    expect(() => parseTimeOutput("bash: /usr/bin/time: No such file or directory")).toThrow(
      "time_output_unrecognized",
    );
  });
});

describe("benchRow", () => {
  const render = {
    targetSeconds: 60,
    scenes: 14,
    videoDurationMs: 59_990,
    fileBytes: 1_000,
    qaVerdict: "pass",
    blockedChecks: [],
    outputPath: "out/render-60s.mp4",
    loadAvg1Before: 0.5,
    renderThreads: 4,
    timings: {
      frames: 1_800,
      composeMs: 3_100.2,
      rasterMs: 24_000.5,
      writeMs: 900,
      encodeMs: 2_200,
      concatMs: 0,
      chunks: 1,
      mixMs: 1_500,
      qaMs: 800,
      totalMs: 41_000,
      framesPerSec: 59.6,
    },
  } as const;
  const usage = { wallS: 41.27, userS: 118.52, sysS: 6.31, peakRssMb: 1200 };

  it("joins the time usage and the render result into one row", () => {
    const row = benchRow({
      usage,
      render,
      machine: "mac-mini-m4",
      run: "warm1",
      ffmpeg: "ffmpeg version 7.1",
      now: new Date("2026-10-01T10:00:00Z"),
    });
    expect(row).toMatchObject({
      machine: "mac-mini-m4",
      run: "warm1",
      date: "2026-10-01T10:00:00.000Z",
      targetSeconds: 60,
      wallS: 41.27,
      cpuS: 124.83,
      peakRssMb: 1200,
      gpu: "none (libx264 on CPU)",
      fileBytes: 1_000,
      qaVerdict: "pass",
      valid: true,
      loadAvg1Before: 0.5,
      host: expect.objectContaining({ ffmpeg: "ffmpeg version 7.1" }),
    });
  });

  it("carries the stage timings and thread setting into the row", () => {
    const row = benchRow({
      usage,
      render,
      machine: "linux-dev",
      run: "warm1",
      ffmpeg: "ffmpeg version 6.1.1",
      now: new Date("2026-10-01T10:00:00Z"),
    });
    expect({ renderThreads: row.renderThreads, timings: row.timings }).toMatchInlineSnapshot(`
      {
        "renderThreads": 4,
        "timings": {
          "chunks": 1,
          "composeMs": 3100.2,
          "concatMs": 0,
          "encodeMs": 2200,
          "frames": 1800,
          "framesPerSec": 59.6,
          "mixMs": 1500,
          "qaMs": 800,
          "rasterMs": 24000.5,
          "totalMs": 41000,
          "writeMs": 900,
        },
      }
    `);
  });

  it("keeps older render JSON without timings mergeable", () => {
    const { timings: _timings, renderThreads: _threads, ...legacy } = render;
    const row = benchRow({
      usage,
      render: legacy as unknown as typeof render,
      machine: "m",
      run: "cold",
      ffmpeg: "f",
    });
    expect(row.timings).toBeNull();
    expect(row.renderThreads).toBeNull();
  });

  it("marks a quality-blocked render invalid", () => {
    const row = benchRow({
      usage,
      render: { ...render, qaVerdict: "block", blockedChecks: ["silence"] },
      machine: "m",
      run: "cold",
      ffmpeg: "f",
    });
    expect(row.valid).toBe(false);
    expect(row.blockedChecks).toEqual(["silence"]);
  });
});
