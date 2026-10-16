import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalAiLimits, readRenderLimits, sweepRenderTemp } from "./render-limits.js";

describe("readRenderLimits", () => {
  it("defaults to a 12-minute render deadline inside a 15-minute lease, nice 10", () => {
    expect(readRenderLimits({})).toEqual({
      leaseDurationMs: 900_000,
      heavyJobTimeoutMs: 720_000,
      nice: 10,
    });
  });

  it("reads overrides, including render threads", () => {
    expect(
      readRenderLimits({ RENDER_JOB_TIMEOUT_MS: "300000", WORKER_NICE: "5", RENDER_THREADS: "2" }),
    ).toEqual({ leaseDurationMs: 900_000, heavyJobTimeoutMs: 300_000, nice: 5, threads: 2 });
  });

  it("refuses a render deadline that does not leave a minute inside the lease", () => {
    expect(() => readRenderLimits({ RENDER_JOB_TIMEOUT_MS: "860000" })).toThrow(
      "render_job_timeout_exceeds_lease",
    );
  });

  it("keeps the long-form deadline unset unless asked, and holds it inside the lease", () => {
    expect(readRenderLimits({}).longFormJobTimeoutMs).toBeUndefined();
    const raised = readRenderLimits({
      LONG_FORM_JOB_TIMEOUT_MS: "1800000",
      WORKER_LEASE_MS: "1900000",
    });
    expect(raised).toMatchObject({ heavyJobTimeoutMs: 720_000, longFormJobTimeoutMs: 1_800_000 });
    expect(() => readRenderLimits({ LONG_FORM_JOB_TIMEOUT_MS: "1800000" })).toThrow(
      "render_job_timeout_exceeds_lease",
    );
  });

  it("reads STICKMAN_LAYER_CACHE as an on/off flag and refuses anything else", () => {
    expect(readRenderLimits({}).layerCache).toBeUndefined();
    expect(readRenderLimits({ STICKMAN_LAYER_CACHE: "0" }).layerCache).toBeUndefined();
    expect(readRenderLimits({ STICKMAN_LAYER_CACHE: "1" }).layerCache).toBe(true);
    expect(readRenderLimits({ STICKMAN_LAYER_CACHE: "true" }).layerCache).toBe(true);
    expect(() => readRenderLimits({ STICKMAN_LAYER_CACHE: "yes" })).toThrow(
      "render_limits_invalid",
    );
  });

  it("rejects malformed values instead of guessing", () => {
    expect(() => readRenderLimits({ RENDER_JOB_TIMEOUT_MS: "soon" })).toThrow(
      "render_limits_invalid",
    );
    expect(() => readRenderLimits({ WORKER_NICE: "30" })).toThrow("render_limits_invalid");
    expect(() => readRenderLimits({ RENDER_THREADS: "0" })).toThrow("render_limits_invalid");
  });

  it("reads a per-worker lease and keeps the render deadline a minute inside it", () => {
    expect(
      readRenderLimits({ WORKER_LEASE_MS: "1800000", RENDER_JOB_TIMEOUT_MS: "1740000" }),
    ).toMatchObject({ leaseDurationMs: 1_800_000, heavyJobTimeoutMs: 1_740_000 });
    expect(() => readRenderLimits({ WORKER_LEASE_MS: "600000" })).toThrow(
      "render_job_timeout_exceeds_lease",
    );
    expect(() =>
      readRenderLimits({ WORKER_LEASE_MS: "60000", RENDER_JOB_TIMEOUT_MS: "10000" }),
    ).toThrow("render_limits_invalid");
  });
});

describe("sweepRenderTemp", () => {
  let root: string;
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes only render temp directories older than the cutoff", async () => {
    root = await mkdtemp(join(tmpdir(), "sweep-test-"));
    const old = join(root, "money-maker-render-reel-old");
    const fresh = join(root, "money-maker-render-motion-fresh");
    const other = join(root, "someone-else-old");
    for (const dir of [old, fresh, other]) {
      await mkdir(dir);
      await writeFile(join(dir, "frame.raw"), "x");
    }
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, past, past);
    await utimes(other, past, past);
    const removed = await sweepRenderTemp({ root, olderThanMs: 60 * 60 * 1000 });
    expect(removed).toEqual(["money-maker-render-reel-old"]);
    expect((await readdir(root)).sort()).toEqual([
      "money-maker-render-motion-fresh",
      "someone-else-old",
    ]);
  });
});

describe("readLocalAiLimits", () => {
  it("defaults to a 25-minute job deadline inside a 30-minute lease", () => {
    expect(readLocalAiLimits({})).toMatchObject({
      leaseDurationMs: 1_800_000,
      localAiJobTimeoutMs: 1_500_000,
    });
  });

  it("ignores the render lease and keeps the deadline a minute inside its own lease", () => {
    expect(readLocalAiLimits({ WORKER_LEASE_MS: "120000" }).leaseDurationMs).toBe(1_800_000);
    expect(
      readLocalAiLimits({ LOCAL_AI_LEASE_MS: "3600000", LOCAL_AI_JOB_TIMEOUT_MS: "3540000" }),
    ).toMatchObject({ leaseDurationMs: 3_600_000, localAiJobTimeoutMs: 3_540_000 });
    expect(() => readLocalAiLimits({ LOCAL_AI_LEASE_MS: "1000000" })).toThrow(
      "local_ai_job_timeout_exceeds_lease",
    );
    expect(() => readLocalAiLimits({ LOCAL_AI_LEASE_MS: "soon" })).toThrow("render_limits_invalid");
    expect(() => readLocalAiLimits({ LOCAL_AI_LEASE_MS: "60000" })).toThrow(
      "render_limits_invalid",
    );
  });
});
