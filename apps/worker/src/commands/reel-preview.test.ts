import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReelRenderInput } from "@money-maker/core/assets/reel-renderer";
import { describe, expect, it, vi } from "vitest";
import { PREVIEW_CASES } from "./post-preview.js";
import { BEATS, REEL_PLANS, runReelPreview } from "./reel-preview.js";

const synthesizer = {
  synthesize: vi.fn(async ({ text }: { text: string }) => ({
    bytes: new Uint8Array([1]),
    mimeType: "audio/wav" as const,
    durationMs: 2000,
    words: [{ text: text.split(" ")[0] ?? "", startMs: 0, endMs: 500 }],
  })),
};

describe("reel-preview", () => {
  it("builds the 5-beat story reel in order and skips incomplete niches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-preview-"));
    await mkdir(join(dir, "posts"));
    for (const part of BEATS) await writeFile(join(dir, "posts", `casa_${part}.jpg`), part);
    await writeFile(join(dir, "posts", "tech_feed.jpg"), "x");
    const inputs: ReelRenderInput[] = [];
    const renderer = {
      render: vi.fn(async (input: ReelRenderInput) => {
        inputs.push(input);
        return {
          bytes: new Uint8Array([9, 9]),
          mimeType: "video/mp4" as const,
          width: 1080,
          height: 1920,
          durationMs: 9000,
        };
      }),
    };
    const result = await runReelPreview({
      inDir: dir,
      outDir: join(dir, "reels"),
      synthesizer,
      renderer,
      log: () => undefined,
    });
    expect(result.skipped).toEqual(["beleza", "tech"]);
    expect(result.reels.map((r) => r.niche)).toEqual(["casa"]);
    const input = inputs[0];
    expect(input?.slides.map((s) => Buffer.from(s.bytes).toString())).toEqual([
      "problem",
      "problem2",
      "discovery",
      "result",
      "feed",
    ]);
    expect(input?.voiceClips).toHaveLength(5);
    expect(input?.timeline?.slides).toHaveLength(5);
    // 2 s clips: every beat 3-4 s, the whole reel under 20 s.
    for (const slide of input?.timeline?.slides ?? [])
      expect(slide.durationSec).toBeGreaterThanOrEqual(3);
    expect(input?.timeline?.totalSec).toBeLessThan(20);
    expect(input?.musicFile).toBeUndefined();
    expect(input?.captionStyle?.theme?.id).toBe("boxed");
    expect(synthesizer.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voiceId: "pf_dora", language: "pt-BR" }),
    );
    expect((await readFile(join(dir, "reels", "casa.mp4"))).byteLength).toBe(2);
    expect(
      JSON.parse(await readFile(join(dir, "reels", "summary.json"), "utf8")).reels,
    ).toHaveLength(1);
  });

  it("mixes the --music file under the voice when given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-preview-"));
    await mkdir(join(dir, "posts"));
    for (const part of BEATS) await writeFile(join(dir, "posts", `tech_${part}.jpg`), part);
    const render = vi.fn(async (_input: ReelRenderInput) => ({
      bytes: new Uint8Array([1]),
      mimeType: "video/mp4" as const,
      width: 1080,
      height: 1920,
      durationMs: 15000,
    }));
    await runReelPreview({
      inDir: dir,
      outDir: join(dir, "reels"),
      synthesizer,
      renderer: { render },
      musicFile: "/music/track.mp3",
      log: () => undefined,
    });
    expect(render.mock.calls[0]?.[0].musicFile).toBe("/music/track.mp3");
  });

  it("tells a conversational story and keeps the price on the offer slide only", () => {
    expect(REEL_PLANS["tech"]?.voiceId).toBe("pm_alex");
    const price = (text: string) => text.match(/R\$ ?[\d.]+,\d{2}/g) ?? [];
    for (const [niche, plan] of Object.entries(REEL_PLANS)) {
      expect(plan.lines).toHaveLength(BEATS.length);
      expect(plan.lines[0]).toMatch(/^Sabe quando/);
      const offer = plan.lines[4];
      expect(offer).toContain("Link na bio");
      const feed = PREVIEW_CASES[`${niche}_feed`];
      expect(price(offer)).toEqual(price(feed?.badge ?? ""));
      expect(feed?.cta).toBe("Link na bio");
      expect(feed?.bubble).toBeUndefined();
      BEATS.slice(0, 4).forEach((beat, index) => {
        const item = PREVIEW_CASES[`${niche}_${beat}`];
        expect(price(plan.lines[index] ?? "")).toEqual([]);
        expect(price(`${item?.headline} ${item?.badge} ${item?.bubble}`)).toEqual([]);
        expect(item?.cta).toBeUndefined();
        expect(item?.bubble?.length).toBeLessThanOrEqual(40);
      });
    }
  });
});
