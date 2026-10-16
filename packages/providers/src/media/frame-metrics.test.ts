import { DEFAULT_SCENE_PALETTE } from "@money-maker/core/explainer/explainer-context";
import {
  STYLE_FRAME_CAPTION_WORDS,
  STYLE_FRAME_CAST,
  STYLE_FRAME_SHOTS,
  styleFrameScene,
  styleFrameTiming,
} from "@money-maker/core/explainer/fixtures/style-frames/fixtures";
import { planMotion } from "@money-maker/core/explainer/motion/plan";
import { FLAT_VECTOR_PROFILE } from "@money-maker/core/explainer/visual-language";
import { blockReasons } from "@money-maker/core/explainer/visual-qa/tunables";
import { describe, expect, it } from "vitest";
import { createVisualQa, measureFrame } from "./frame-metrics.js";

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("fixture missing");
  return value;
};

const planForShot = (index: number, visualLanguage?: typeof FLAT_VECTOR_PROFILE) => {
  const shot = STYLE_FRAME_SHOTS[index];
  if (!shot) throw new Error("fixture");
  return planMotion({
    scenes: [styleFrameScene(shot)],
    timings: [styleFrameTiming(shot)],
    characters: STYLE_FRAME_CAST,
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: STYLE_FRAME_CAPTION_WORDS,
    durationMs: shot.durationMs,
    ...(visualLanguage ? { visualLanguage } : {}),
  });
};

describe("visual QA on the golden style frames", () => {
  const qa = createVisualQa();

  it("passes the thumbnail gate on every style frame, flat and with the flat profile", async () => {
    const ids: Record<string, readonly string[]> = {};
    for (const [index, shot] of STYLE_FRAME_SHOTS.entries()) {
      for (const profile of [undefined, FLAT_VECTOR_PROFILE]) {
        const findings = await qa.thumbnail(planForShot(index, profile));
        expect(blockReasons(findings), `${shot.id} ${profile ? "profile" : "default"}`).toEqual([]);
        if (profile) ids[shot.id] = findings.map((entry) => entry.id).sort();
      }
    }
    expect(ids).toMatchSnapshot();
  }, 120_000);

  it("runs the raster checks on a landscape plan against the landscape safe box", async () => {
    const shot = must(STYLE_FRAME_SHOTS[0]);
    const plan = planMotion({
      scenes: [styleFrameScene(shot)],
      timings: [styleFrameTiming(shot)],
      characters: STYLE_FRAME_CAST,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: STYLE_FRAME_CAPTION_WORDS,
      durationMs: shot.durationMs,
      canvas: "landscape",
    });
    const metrics = await measureFrame(plan, 0, 1_400);
    expect(metrics.actorAreaPct).toBeGreaterThan(1);
    expect(metrics.texts.length).toBeGreaterThan(0);
    // Captions are measured in the landscape band, so a clean fixture frame has no collisions.
    expect(metrics.texts.every((entry) => entry.text.box.right <= 1920)).toBe(true);
    expect(blockReasons(await qa.thumbnail(plan))).toEqual([]);
  }, 60_000);

  it("measures one actor and one text box on a hook frame", async () => {
    const plan = planForShot(0);
    const metrics = await measureFrame(plan, 0, 1_400);
    expect(metrics.actorAreaPct).toBeGreaterThan(1);
    expect(metrics.actorCentroid?.x).toBeGreaterThan(0.35);
    expect(metrics.texts.length).toBeGreaterThan(0);
    expect(metrics.meanHex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("reports a colour strip with one hex per scene and never changes the verdict", async () => {
    const section = await qa.report(planForShot(0));
    expect(section.colorStrip).toHaveLength(1);
    expect(section.findings.every((entry) => entry.severity !== "BLOCK")).toBe(true);
  });
});

describe("a deliberately broken plan", () => {
  it("blocks the thumbnail gate with named reasons", async () => {
    const plan = planForShot(0);
    const scene = must(plan.scenes[0]);
    // Light caption plate under white text, plus a timeline that runs past the render.
    const broken = {
      ...plan,
      palette: { ...plan.palette, line: "#F4F4F4" },
      scenes: [{ ...scene, endMs: plan.durationMs + 10_000 }],
    };
    const reasons = blockReasons(await createVisualQa().thumbnail(broken));
    expect(reasons).toEqual(expect.arrayContaining(["caption_contrast", "timeline_invalid"]));
  });

  it("blocks an actor standing on top of overlay text, measured from pixels", async () => {
    const plan = planForShot(0);
    const scene = must(plan.scenes[0]);
    const overlay = { text: "l", position: "middle", emphasis: true } as const;
    const broken = { ...plan, scenes: [{ ...scene, overlays: [{ overlay, atMs: 0 }] }] };
    expect(blockReasons(await createVisualQa().thumbnail(broken))).toContain(
      "actor_text_collision",
    );
  });
});
