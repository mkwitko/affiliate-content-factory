import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE } from "../../explainer-context.js";
import { composeMotionFrame } from "../../motion/frame.js";
import { planMotion } from "../../motion/plan.js";
import { validateSceneSpecs } from "../../scene-spec.js";
import { STYLE_CANDIDATES, styleCandidate } from "./candidates.js";
import {
  MOTION_TEST_ID,
  STYLE_FRAME_CAPTION_WORDS,
  STYLE_FRAME_CAST,
  STYLE_FRAME_CLAIMS,
  STYLE_FRAME_LANGUAGE,
  STYLE_FRAME_SHOTS,
  styleFrameScene,
  styleFrameStoryboard,
  styleFrameTiming,
} from "./fixtures.js";

describe("style-frame fixtures", () => {
  it("covers the 10 mandatory frames, the 2 optional ones and the motion test", () => {
    const frames = new Set(STYLE_FRAME_SHOTS.map((shot) => shot.frame));
    expect([...frames].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(STYLE_FRAME_SHOTS.filter((shot) => shot.optional).map((shot) => shot.frame)).toEqual([
      11, 12, 12,
    ]);
    expect(STYLE_FRAME_SHOTS.filter((shot) => shot.frame === 2)).toHaveLength(6);
    expect(new Set(STYLE_FRAME_SHOTS.map((shot) => shot.id)).size).toBe(STYLE_FRAME_SHOTS.length);
  });

  it("is one storyboard the motion validator accepts", () => {
    const { scenes, texts } = styleFrameStoryboard();
    expect(
      validateSceneSpecs({
        scenes,
        characters: STYLE_FRAME_CAST,
        claims: STYLE_FRAME_CLAIMS,
        renderer: "stickman_motion",
        language: STYLE_FRAME_LANGUAGE,
        sceneTexts: texts,
      }),
    ).toEqual({ ok: true });
  });

  it("keeps the motion test six seconds long with a static camera and the spec's beats", () => {
    const motion = STYLE_FRAME_SHOTS.find((shot) => shot.id === MOTION_TEST_ID);
    expect(motion?.durationMs).toBe(6_000);
    expect(motion?.scene.camera.movement).toBe("none");
    expect(motion?.scene.actors[0]?.actions?.map((action) => action.type)).toEqual([
      "enter",
      "look_at",
      "point_at",
    ]);
    expect(motion?.scene.captionMode).toBe("word");
  });

  it("keeps the night and warm variants in frame 3's location", () => {
    const location = STYLE_FRAME_SHOTS.find((shot) => shot.frame === 3)?.scene.background;
    for (const frame of [8, 9]) {
      const shot = STYLE_FRAME_SHOTS.find((entry) => entry.frame === frame);
      expect(shot?.scene.background).toBe(location);
      expect(shot?.grade).toBe(frame === 8 ? "night" : "warm");
    }
  });

  it("times every word inside the shot and takes the still while narration plays", () => {
    for (const shot of STYLE_FRAME_SHOTS) {
      const timing = styleFrameTiming(shot);
      expect(timing.words.length).toBeGreaterThan(0);
      expect(timing.words.at(-1)?.endMs).toBeLessThanOrEqual(shot.durationMs);
      expect(shot.atMs).toBeGreaterThan(timing.voiceStartMs);
      expect(shot.atMs).toBeLessThan(shot.durationMs);
    }
  });

  it.each(STYLE_CANDIDATES.map((candidate) => [candidate.id, candidate] as const))(
    "%s plans and composes every shot deterministically",
    (_id, candidate) => {
      for (const shot of STYLE_FRAME_SHOTS) {
        const compose = () =>
          composeMotionFrame(
            planMotion({
              scenes: [styleFrameScene(shot)],
              timings: [styleFrameTiming(shot)],
              characters: STYLE_FRAME_CAST,
              palette: DEFAULT_SCENE_PALETTE,
              captionWords: STYLE_FRAME_CAPTION_WORDS,
              durationMs: shot.durationMs,
              lineStyle: candidate.lineStyle,
            }),
            shot.atMs,
          );
        const svg = compose();
        expect(svg).toContain("<svg");
        expect(compose()).toBe(svg);
      }
    },
  );

  it("names the two spec candidates and the control, and rejects unknown ids", () => {
    expect(STYLE_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      "flat-vector-control",
      "expressive-ink-cutout-painted",
      "expressive-ink-gouache-painted",
    ]);
    expect(styleCandidate("flat-vector-control").plateStyle).toBeNull();
    expect(() => styleCandidate("nope")).toThrow("style_candidate_unknown:nope");
  });
});
