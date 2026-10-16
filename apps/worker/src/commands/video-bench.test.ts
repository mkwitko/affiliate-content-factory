import type { VideoGenerator } from "@money-maker/providers/media/sdcpp-video-generator";
import { describe, expect, it } from "vitest";
import {
  KEYFRAMES,
  readVideoBenchCandidates,
  runVideoBench,
  summarizeVideoBench,
  type VideoCandidate,
} from "./video-bench.js";

const WAN = "local:wan2.2-ti2v-5b";
const cand = (model = WAN): VideoCandidate => ({
  baseUrl: "http://127.0.0.1:1",
  model,
  quantization: "Q4_K_M",
  steps: 20,
});
const keyframes = new Map(KEYFRAMES.map((k) => [k.file, new Uint8Array([1])]));
const probe = (over: object = {}) => ({
  probe: {
    readable: true,
    hasVideo: true,
    width: 832,
    height: 480,
    frameCount: 17,
    durationMs: 1000,
    decodeErrors: 0,
    ...over,
  },
  meanFrameDiff: 3.5,
});
const okGenerator: VideoGenerator = {
  generate: async () => ({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: "video/webm",
    model: WAN,
    seed: 1,
    provenance: { runtime: "stable-diffusion.cpp" },
  }),
};

describe("video bench", () => {
  it("validates the candidate JSON", () => {
    expect(() => readVideoBenchCandidates({})).toThrow("video_bench_candidates_invalid");
    expect(() =>
      readVideoBenchCandidates({
        VIDEO_BENCH_CANDIDATES: JSON.stringify([{ baseUrl: "x", model: WAN, steps: 50 }]),
      }),
    ).toThrow("video_bench_candidates_invalid");
    expect(
      readVideoBenchCandidates({
        VIDEO_BENCH_CANDIDATES: JSON.stringify([
          { baseUrl: "http://127.0.0.1:1", model: WAN, quantization: "Q4_K_M", steps: 20 },
        ]),
      }),
    ).toHaveLength(1);
  });

  it("runs 5 keyframes x 17/25/33 frames at 16 fps, flags a disabled model and nulls manual fields", async () => {
    const rows = await runVideoBench([cand()], {
      canvas: "landscape",
      keyframes,
      createGenerator: () => okGenerator,
      measure: async () => probe(),
    });
    expect(rows).toHaveLength(15);
    expect(new Set(rows.map((r) => r.frames))).toEqual(new Set([17, 25, 33]));
    expect(rows[0]).toMatchObject({
      model: WAN,
      quantization: "Q4_K_M",
      resolution: "832x480",
      fps: 16,
      steps: 20,
      policyEnabled: false,
      outputBytes: 3,
      decodeValid: true,
      frameCount: 17,
      corruptFrames: 0,
      meanFrameDiff: 3.5,
      peakVramMb: null,
      peakRamMb: null,
      subjectDrift: null,
      characterDrift: null,
      styleDrift: null,
      motionQuality: null,
      vlmFindings: null,
      humanScore: null,
      error: null,
    });
    expect(summarizeVideoBench(rows)).toMatchObject({
      promoted: false,
      models: [{ model: WAN, policyEnabled: false, rows: 15, failures: 0, promoted: false }],
    });
  });

  it("one failing case or candidate does not stop the rest; decode errors are recorded", async () => {
    let calls = 0;
    const flaky: VideoGenerator = {
      generate: async (input) => {
        calls += 1;
        if (calls === 1) throw new Error("sdcpp_timeout");
        return okGenerator.generate(input);
      },
    };
    const rows = await runVideoBench([cand(), cand("local:flux-1-schnell")], {
      canvas: "portrait",
      keyframes,
      createGenerator: () => flaky,
      measure: async () => probe({ decodeErrors: 2, frameCount: 10 }),
    });
    expect(rows[0]).toMatchObject({ error: "sdcpp_timeout", resolution: "480x832" });
    expect(rows[1]).toMatchObject({
      error: null,
      decodeValid: false,
      corruptFrames: 2,
      frameCount: 10,
    });
    // the second candidate is an image model: refused once, no generation
    expect(rows.at(-1)).toMatchObject({
      model: "local:flux-1-schnell",
      keyframe: "all",
      error: "model_not_video_generation",
    });
    expect(calls).toBe(15);
  });

  it("refuses unknown models and reports missing keyframes", async () => {
    const rows = await runVideoBench([cand("nope")], {
      canvas: "landscape",
      keyframes,
      createGenerator: () => okGenerator,
    });
    expect(rows).toEqual([expect.objectContaining({ error: "model_not_allowed" })]);
    const missing = await runVideoBench([cand()], {
      canvas: "landscape",
      keyframes: new Map(),
      createGenerator: () => okGenerator,
    });
    expect(missing).toHaveLength(15);
    expect(missing.every((r) => r.error === "keyframe_missing")).toBe(true);
  });

  it("reports a generator that cannot be built (disabled adapter, bad host) as one row", async () => {
    const rows = await runVideoBench([cand()], {
      canvas: "landscape",
      keyframes,
      createGenerator: () => {
        throw new Error("sdcpp_url_not_local");
      },
    });
    expect(rows).toEqual([
      expect.objectContaining({ keyframe: "all", error: "sdcpp_url_not_local" }),
    ]);
  });
});
