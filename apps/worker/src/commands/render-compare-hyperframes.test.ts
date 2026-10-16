import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blindOrder,
  buildComparePlan,
  COMPARE_CASES,
  QUESTIONS,
  renderBoth,
  renderIndexHtml,
} from "./render-compare-hyperframes.js";

describe("hyperframes comparison pack", () => {
  it("has the eight fixture cases and builds a deterministic landscape plan for each", () => {
    expect(COMPARE_CASES.map((c) => c.id)).toEqual([
      "hook",
      "sam_character",
      "price_reveal",
      "diagram",
      "comparison",
      "location_shot",
      "information_heavy",
      "payoff",
    ]);
    for (const c of COMPARE_CASES) {
      const a = buildComparePlan(c, 6);
      expect(a.plan.canvas).toBe("landscape");
      expect(a.plan.durationMs).toBe(6_000);
      expect(buildComparePlan(c, 6).plan).toEqual(a.plan);
    }
  });

  it("hands the identical input object to both renderers, and one failing does not stop the other", async () => {
    const { plan, voiceStartMs } = buildComparePlan(COMPARE_CASES[0] as never, 6);
    const input = { plan, voiceClips: [new Uint8Array([1])], voiceStartMs };
    const seen: unknown[] = [];
    const dir = await mkdtemp(join(tmpdir(), "hf-compare-test-"));
    try {
      const { h } = await renderBoth(
        input,
        {
          stickman: {
            render: async (i) => {
              seen.push(i);
              return { bytes: new Uint8Array(), timings: { encodeMs: 5 } } as never;
            },
          },
          hyperframes: {
            render: async (i) => {
              seen.push(i);
              throw new Error("hyperframes_render_failed:7");
            },
          },
        },
        { sFile: join(dir, "s.mp4"), hFile: join(dir, "h.mp4") },
      );
      expect(seen).toHaveLength(2);
      expect(seen[0]).toBe(input);
      expect(seen[1]).toBe(input);
      expect(h.error).toBe("hyperframes_render_failed:7");
      expect(h.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("shuffles A/B with a fixed seed and builds a blind page with five questions", () => {
    const ids = COMPARE_CASES.map((c) => c.id);
    const order = blindOrder("hyperframes-ab-v1", ids);
    expect(blindOrder("hyperframes-ab-v1", ids)).toEqual(order);
    expect(new Set(Object.values(order).map((o) => o[0])).size).toBe(2);
    expect(QUESTIONS).toHaveLength(5);
    const html = renderIndexHtml({
      generatedAt: "x",
      seconds: 6,
      voice: "tone",
      hyperframesVersion: "0.8.112",
      node: "v24",
      notes: [],
      order,
      cases: COMPARE_CASES.map((c) => ({ id: c.id, title: c.title, text: c.text }) as never),
      renderers: {} as never,
    });
    for (const q of QUESTIONS) expect(html).toContain(q);
    expect(html).toContain("hyperframes-ab-answers.json");
    expect(html).not.toMatch(/src="[^"]*(stickman|hyperframes)/);
  });
});
