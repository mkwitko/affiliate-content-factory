import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE } from "../explainer-context.js";
import { COST_CURIOUS_CAST } from "../fixtures/cast/cost-curious-cast.js";
import { GOUACHE_V1 } from "../fixtures/visual-language/gouache-v1.js";
import { planMotion } from "../motion/plan.js";
import type { SceneSpec } from "../scene-spec.js";
import { readVisualLanguageProfile } from "../visual-language.js";
import { compositionFromPlan, visualTokensFor } from "./composition.js";

const TEXT = "Every fee changes the final number you pay";
const tokens = TEXT.split(" ");
const spec = (index: number, extra: Partial<SceneSpec>): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: TEXT.length,
  purpose: "explanation",
  background: "grid",
  layoutId: "ACTOR_DIAGRAM_SPLIT",
  actors: [{ characterKey: "sam", pose: "pointing", expression: "happy", position: "left" }],
  props: [{ type: "document", position: "right", label: "Terms" }],
  overlays: [{ text: "READ THIS", position: "top", emphasis: true }],
  camera: { shot: "medium", movement: "slow_zoom_in" },
  transition: "hard_cut",
  captionMode: "word",
  ...extra,
});
const timing = (startMs: number) => ({
  startMs,
  endMs: startMs + 4_000,
  voiceStartMs: startMs + 200,
  voiceEndMs: startMs + 3_700,
  text: TEXT,
  words: tokens.map((text, i) => ({
    text,
    startMs: startMs + 200 + i * 400,
    endMs: startMs + 200 + i * 400 + 360,
  })),
});
const visualLanguage = readVisualLanguageProfile(GOUACHE_V1) ?? undefined;
const plan = planMotion({
  scenes: [
    spec(1, { diagram: { kind: "counter", from: 0, to: 30, unit: "%" } }),
    spec(2, {
      diagram: {
        kind: "bar_compare",
        items: [
          { label: "A", value: 40 },
          { label: "B", value: 70 },
        ],
      },
    }),
  ],
  timings: [timing(0), timing(4_000)],
  characters: COST_CURIOUS_CAST,
  palette: DEFAULT_SCENE_PALETTE,
  captionWords: 3,
  durationMs: 8_000,
  canvas: "landscape",
  ...(visualLanguage ? { visualLanguage, compositing: visualLanguage.compositing } : {}),
});

describe("visualTokensFor", () => {
  it("maps the plan palette and visual language to CSS variables", () => {
    const t = visualTokensFor(plan);
    expect(t["--hf-surface"]).toBe(visualLanguage?.palette.roles.bgFar);
    expect(t["--hf-accent"]).toBe(visualLanguage?.palette.roles.accent);
    expect(t["--hf-caption-px"]).toBe(String(visualLanguage?.type.captionPx[1]));
  });
  it("falls back to the scene palette without a visual language", () => {
    const bare = planMotion({
      ...{ scenes: [spec(1, {})], timings: [timing(0)] },
      characters: COST_CURIOUS_CAST,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 4_000,
    });
    expect(visualTokensFor(bare)["--hf-surface"]).toBe(DEFAULT_SCENE_PALETTE.surface);
  });
});

describe("compositionFromPlan", () => {
  const html = compositionFromPlan(plan, visualTokensFor(plan), {
    audio: [{ src: "voice-0.wav", startMs: 200, durationMs: 3_500 }],
    fonts: [{ weight: 400, src: "fonts/Inter-400.ttf" }],
  });
  it("declares the HyperFrames root, one scene per plan scene and the audio clip", () => {
    expect(html).toContain('data-composition-id="root"');
    expect(html).toContain('data-width="1920" data-height="1080" data-duration="8.000"');
    expect(html.match(/<section class="scene"/g)).toHaveLength(2);
    expect(html).toContain('<audio id="voice-0" data-start="0.200" data-duration="3.500"');
  });
  it("is deterministic and contains no network reference or script", () => {
    expect(
      compositionFromPlan(plan, visualTokensFor(plan), {
        audio: [{ src: "voice-0.wav", startMs: 200, durationMs: 3_500 }],
        fonts: [{ weight: 400, src: "fonts/Inter-400.ttf" }],
      }),
    ).toBe(html);
    expect(html).not.toMatch(/https?:|\/\/cdn|<script|@import/i);
  });
  it("matches the stored snapshot", () => {
    expect(html).toMatchSnapshot();
  });
});
