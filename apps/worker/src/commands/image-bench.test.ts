import { crc32, deflateSync } from "node:zlib";
import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import { IMAGE_BENCH_CORPUS } from "@money-maker/core/explainer/fixtures/image-bench-corpus";
import { describe, expect, it } from "vitest";
import {
  type Candidate,
  readImageBenchCandidates,
  resizeCases,
  runImageBench,
  summarizeImageBench,
} from "./image-bench.js";

const cand = (model: string, baseUrl = "http://127.0.0.1:1"): Candidate => ({
  baseUrl,
  model,
  runtime: "stable-diffusion.cpp",
  quantization: "Q4_K_M",
  steps: 8,
  cacheMode: null,
});
const oneCase = IMAGE_BENCH_CORPUS.slice(0, 1).map((c) => ({ ...c, seeds: [1] }));

const chunk = (type: string, data: Buffer): Buffer => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};
/** Small RGB PNG with a pixel pattern so the luma spread is not zero. */
const png = (width: number, height: number): Uint8Array => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % stride === 0 ? 0 : (i * 37) % 256;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};
const image = (bytes: Uint8Array, width: number, height: number) => ({
  bytes,
  mimeType: "image/png" as const,
  width,
  height,
  neurons: 0,
});
const goodGenerator: SceneGenerator = {
  generate: async (_p, size) => image(png(size?.width ?? 0, size?.height ?? 0), 0, 0),
};

describe("corpus", () => {
  it("has 8 frozen cases with 64-aligned sizes", () => {
    expect(IMAGE_BENCH_CORPUS).toHaveLength(8);
    expect(Object.isFrozen(IMAGE_BENCH_CORPUS)).toBe(true);
    for (const c of IMAGE_BENCH_CORPUS) {
      expect((c.width % 64) + (c.height % 64)).toBe(0);
      expect(Math.min(c.width, c.height)).toBeGreaterThanOrEqual(512);
      expect(Math.max(c.width, c.height)).toBeLessThanOrEqual(1536);
    }
  });
});

describe("runImageBench", () => {
  it("refuses image_editing and keeps going after a failing candidate", async () => {
    const rows = await runImageBench(
      [
        cand("local:flux-2-klein-4b"),
        cand("local:z-image-turbo", "http://example.com"),
        cand("local:flux-1-schnell"),
      ],
      {
        runs: 1,
        cases: oneCase,
        createGenerator: (c) => {
          if (c.baseUrl.includes("example")) throw new Error("sdcpp_url_not_local");
          return goodGenerator;
        },
      },
    );
    expect(rows.map((r) => r.error)).toEqual([
      "model_not_image_generation",
      "sdcpp_url_not_local",
      null,
    ]);
    expect(rows[2]).toMatchObject({
      firstRequest: true,
      decodeValid: true,
      dimensionsValid: true,
      corrupt: false,
      reencodeOk: true,
      deterministicQa: true,
      peakVramMb: null,
      peakRamMb: null,
      humanScore: null,
      vlmScore: null,
    });
  });

  it("flags malformed bytes as corrupt and wrong dimensions", async () => {
    let n = 0;
    const gen: SceneGenerator = {
      generate: async () => {
        n += 1;
        return n === 1 ? image(new Uint8Array([1, 2, 3]), 1, 1) : image(png(64, 64), 64, 64);
      },
    };
    const rows = await runImageBench([cand("local:z-image-turbo")], {
      runs: 2,
      cases: oneCase,
      createGenerator: () => gen,
    });
    expect(rows[0]).toMatchObject({ corrupt: true, decodeValid: false, firstRequest: true });
    expect(rows[1]).toMatchObject({
      corrupt: false,
      decodeValid: true,
      dimensionsValid: false,
      firstRequest: false,
    });
  });

  it("records a generator failure as an error row and continues", async () => {
    let n = 0;
    const gen: SceneGenerator = {
      generate: async (_p, size) => {
        n += 1;
        if (n === 1) throw new Error("sdcpp_http_500");
        return image(png(size?.width ?? 0, size?.height ?? 0), 0, 0);
      },
    };
    const rows = await runImageBench([cand("local:z-image-turbo")], {
      runs: 2,
      cases: oneCase,
      createGenerator: () => gen,
    });
    expect(rows.map((r) => r.error)).toEqual(["sdcpp_http_500", null]);
  });

  it("abandons a candidate after three failures in a row", async () => {
    const gen: SceneGenerator = {
      generate: async () => {
        throw new Error("sdcpp_timeout");
      },
    };
    const rows = await runImageBench([cand("local:z-image-turbo")], {
      runs: 10,
      cases: oneCase,
      createGenerator: () => gen,
    });
    expect(rows.map((r) => r.error)).toEqual(["sdcpp_timeout", "sdcpp_timeout", "sdcpp_timeout"]);
  });
});

describe("summarizeImageBench", () => {
  it("computes p50, p95 and the gate, never promoting", async () => {
    const rows = await runImageBench([cand("local:z-image-turbo")], {
      runs: 3,
      cases: oneCase,
      createGenerator: () => goodGenerator,
    });
    const timed = rows.map((r, i) => ({ ...r, wallMs: [1000, 2000, 700_000][i] ?? 0 }));
    const summary = summarizeImageBench(timed, 3);
    expect(summary.promoted).toBe(false);
    expect(summary.models[0]).toMatchObject({
      rows: 3,
      failures: 0,
      corrupt: 0,
      p50WallMs: 2000,
      p95WallMs: 700_000,
      promoted: false,
      gate: {
        maxPlateSec: 600,
        passLatency: false,
        zeroCorruptInRuns: true,
        noCrash: true,
        reencodeOk: true,
        humanReviewPending: true,
      },
    });
  });
});

describe("resizeCases", () => {
  it("overrides sizes with a 64-aligned size and refuses anything else", () => {
    const [resized] = resizeCases(oneCase, "512x896");
    expect(resized).toMatchObject({ width: 512, height: 896 });
    expect(resized?.id).toMatch(/@512x896$/);
    expect(resizeCases(oneCase, undefined)).toBe(oneCase);
    expect(() => resizeCases(oneCase, "500x896")).toThrow("image_bench_size_invalid");
  });
});

describe("readImageBenchCandidates", () => {
  it("validates the env JSON", () => {
    expect(() => readImageBenchCandidates({})).toThrow("image_bench_candidates_invalid");
    expect(
      readImageBenchCandidates({
        IMAGE_BENCH_CANDIDATES: JSON.stringify([
          { baseUrl: "http://127.0.0.1:1", model: "m", runtime: "r", steps: 4 },
        ]),
      })[0],
    ).toMatchObject({ quantization: null, steps: 4, cacheMode: null });
    expect(
      readImageBenchCandidates({
        IMAGE_BENCH_CANDIDATES: JSON.stringify([
          { baseUrl: "http://127.0.0.1:1", model: "m", runtime: "r", cacheMode: "easycache" },
        ]),
      })[0],
    ).toMatchObject({ cacheMode: "easycache" });
    expect(() =>
      readImageBenchCandidates({
        IMAGE_BENCH_CANDIDATES: JSON.stringify([
          { baseUrl: "http://127.0.0.1:1", model: "m", runtime: "r", cacheMode: "warp" },
        ]),
      }),
    ).toThrow("image_bench_candidates_invalid");
  });
});
