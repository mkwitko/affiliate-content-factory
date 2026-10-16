import { describe, expect, it } from "vitest";
import { composeSceneSvg } from "../compose-scene.js";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "../explainer-context.js";
import type { StagePosition } from "../layout.js";
import {
  type ActorAction,
  EMOTIONS,
  type SceneCamera,
  type SceneProp,
  type SceneSpec,
} from "../scene-spec.js";
import { composeMotionFrame, sceneIndexAt } from "./frame.js";
import { type MotionPlan, type MotionSceneTiming, planMotion } from "./plan.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const base = (index: number, over: Partial<SceneSpec>): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: 1,
  purpose: "explanation",
  background: "store",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "left" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const timing = (startMs: number, text: string): MotionSceneTiming => {
  const words = text.split(" ").map((word, i) => ({
    text: word,
    startMs: startMs + 300 + i * 400,
    endMs: startMs + 300 + i * 400 + 350,
  }));
  const voiceEndMs = startMs + 300 + words.length * 400;
  return { startMs, endMs: voiceEndMs + 400, voiceStartMs: startMs + 300, voiceEndMs, words, text };
};
const scenes: readonly SceneSpec[] = [
  base(1, {
    purpose: "hook",
    overlays: [{ text: "WHY THE BACK?", position: "top", emphasis: true }],
    actors: [
      {
        characterKey: "alex",
        pose: "neutral",
        expression: "neutral",
        position: "center",
        actions: [{ type: "enter", atWord: 0, from: "left" }],
      },
    ],
  }),
  base(2, {
    transition: "wipe",
    props: [{ type: "milk_carton", position: "right", label: "Milk" }],
    diagram: { kind: "counter", from: 0, to: 12, unit: "aisles", claimRef: 0 },
  }),
  base(3, {
    purpose: "payoff",
    transition: "fade",
    camera: { shot: "close", movement: "slow_zoom_in" },
  }),
];
const timings = [
  timing(0, "Why is the milk at the back?"),
  timing(3_100, "Because you pass twelve aisles"),
  timing(5_800, "and buy more."),
];
const plan = planMotion({
  scenes,
  timings,
  characters: [alex],
  palette: DEFAULT_SCENE_PALETTE,
  captionWords: 3,
  durationMs: timings.at(-1)?.endMs ?? 0,
});

describe("composeMotionFrame", () => {
  it("is deterministic: the same time draws the same frame", () => {
    for (const t of [0, 450, 3_150, 4_000, 6_000])
      expect(composeMotionFrame(plan, t)).toBe(composeMotionFrame(plan, t));
  });

  it("walks an entering actor in from off-frame", () => {
    const xAt = (t: number) =>
      Number(composeMotionFrame(plan, t).match(/<g transform="translate\((-?[\d.]+),1180\)/)?.[1]);
    expect(xAt(100)).toBeLessThan(0);
    expect(xAt(1_000)).toBeGreaterThan(xAt(600));
    expect(xAt(2_900)).toBe(540);
  });

  it("lip-syncs the narrator only while a word is spoken", () => {
    const speaking = composeMotionFrame(plan, 300 + 400 * 2 + 100);
    const pause = composeMotionFrame(plan, 300 + 400 * 2 + 380);
    expect(speaking).not.toBe(pause);
  });

  it("highlights the word being spoken in the caption band", () => {
    const frame = composeMotionFrame(plan, 300 + 400 + 50);
    expect(frame).toContain('data-caption="1"');
    expect(frame).toContain(`<tspan fill="${DEFAULT_SCENE_PALETTE.accent}">is </tspan>`);
  });

  it("slams overlay words in one after another", () => {
    const early = composeMotionFrame(plan, 300 + 40);
    const late = composeMotionFrame(plan, 300 + 600);
    expect(early).toContain(">WHY<");
    expect(early).not.toContain(">BACK?<");
    expect(late).toContain(">BACK?<");
  });

  it("builds the diagram and pops props during the scene", () => {
    const start = composeMotionFrame(plan, 3_150);
    const later = composeMotionFrame(plan, 5_700);
    expect(start).not.toContain('data-prop="milk_carton"');
    expect(later).toContain('data-prop="milk_carton"');
    expect(later).toContain(">12 aisles<");
  });

  it("whips between scenes on a wipe and crossfades on a fade", () => {
    expect(composeMotionFrame(plan, 3_100 + 150)).toContain('filter="url(#mm-whip)"');
    expect(composeMotionFrame(plan, 5_800 + 150)).toMatch(/<g opacity="0\.5">/);
    expect(composeMotionFrame(plan, 5_800 + 400)).not.toContain("url(#mm-whip)");
  });

  it("finds the scene on screen at any time", () => {
    expect([0, 3_099, 3_100, 9_000].map((t) => sceneIndexAt(plan, t))).toEqual([0, 0, 1, 2]);
  });

  it("settles on the same stage layout as the still once motion ends", () => {
    const still = composeSceneSvg(scenes[1] as SceneSpec, {
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
    });
    const frame = composeMotionFrame(plan, 5_750);
    // The prop sits where the still places it.
    const anchor = (svg: string) => svg.match(/data-prop="milk_carton" transform="([^"]+)"/)?.[1];
    expect(anchor(frame)).toBe(anchor(still));
  });

  it("holds breath and blinks only while an actor is idle", () => {
    const actorScale = (t: number) =>
      composeMotionFrame(plan, t).match(
        /<g transform="translate\(-?[\d.]+,1180\) scale\(([\d.]+)\)/,
      )?.[1];
    const eyesOpen = (t: number) =>
      [...composeMotionFrame(plan, t).matchAll(/cy="-8" rx="7" ry="([\d.]+)"/g)].every(
        (match) => match[1] === "7",
      );
    // Scene 1: the entrance walks 760 px from 300 ms, ending at about 1762 ms.
    const walking = Array.from({ length: 40 }, (_, i) => 320 + i * 33);
    expect(new Set(walking.map(actorScale))).toEqual(new Set(["1"]));
    expect(walking.every(eyesOpen)).toBe(true);
    // Scene 2 (from 3100 ms, after its 300 ms wipe): no actions; the diagram shrinks it to 0.55.
    const idle = Array.from({ length: 70 }, (_, i) => 3_400 + i * 33);
    expect(new Set(idle.map(actorScale)).size).toBeGreaterThan(1);
    expect(idle.every(eyesOpen)).toBe(false);
  });

  it("draws a representative frame", () => {
    expect(composeMotionFrame(plan, 1_200)).toMatchSnapshot();
  });
});

describe("point_at", () => {
  // Words every 400 ms from 300 ms: word 1 starts at 700; the default 1200 ms holds to 1900.
  const pointTiming = timing(0, "look at this price right now");
  const planWith = (
    actions: readonly ActorAction[],
    position: StagePosition,
    propPosition: SceneProp["position"],
  ) =>
    planMotion({
      scenes: [
        base(1, {
          purpose: "hook",
          background: "plain",
          props: [{ type: "coin", position: propPosition }],
          actors: [
            { characterKey: "alex", pose: "neutral", expression: "neutral", position, actions },
          ],
        }),
      ],
      timings: [pointTiming],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: pointTiming.endMs,
    });
  const point: ActorAction = { type: "point_at", atWord: 1, target: { kind: "prop", index: 0 } };
  /** Front-arm angle in rig degrees (0 down, 90 forward, 180 up): the last polyline drawn. */
  const armDegrees = (svg: string): number => {
    const points = [...svg.matchAll(/<polyline [^>]*points="([^"]+)"\/>/g)].at(-1)?.[1] ?? "";
    const [root, , end] = points.split(" ").map((pair) => pair.split(",").map(Number));
    const dx = (end?.[0] ?? 0) - (root?.[0] ?? 0);
    const dy = (end?.[1] ?? 0) - (root?.[1] ?? 0);
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  };
  const hold = 1_300;
  const after = 2_500;

  it("raises the front arm at a prop ahead and returns to the previous pose after", () => {
    const pointing = planWith([point], "left", "right");
    const still = planWith([], "left", "right");
    // Shoulder at (300, 826), carton at (780, 780): about 95.5 degrees.
    expect(armDegrees(composeMotionFrame(pointing, hold))).toBeGreaterThan(90);
    expect(armDegrees(composeMotionFrame(pointing, hold))).toBeLessThan(100);
    expect(armDegrees(composeMotionFrame(still, hold))).toBeLessThan(30);
    expect(composeMotionFrame(pointing, after)).toBe(composeMotionFrame(still, after));
  });

  it("turns to face a target behind it only while pointing", () => {
    const pointing = planWith([point], "right", "left");
    expect(composeMotionFrame(pointing, hold)).toContain("scale(-1,1)");
    expect(armDegrees(composeMotionFrame(pointing, hold))).toBeGreaterThan(90);
    expect(composeMotionFrame(pointing, after)).not.toContain("scale(-1,1)");
  });

  it("points straight up at a prop overhead without turning", () => {
    const frame = composeMotionFrame(planWith([point], "center", "top"), hold);
    // Straight up is 180 or -180 depending on the sign of a rounded zero.
    expect(Math.abs(armDegrees(frame))).toBeGreaterThan(170);
    expect(frame).not.toContain("scale(-1,1)");
    expect(frame).not.toContain("NaN");
  });

  it("draws a point that real narration squeezed into a walk without breaking", () => {
    const walk: ActorAction = { type: "walk_to", atWord: 0, to: "right", durationMs: 2_000 };
    const squeezed = planWith([walk, point], "left", "right");
    for (const t of [500, 900, 1_300, 1_800])
      expect(composeMotionFrame(squeezed, t)).not.toContain("NaN");
  });
});

describe("look_at", () => {
  const bia: ExplainerCharacter = { ...alex, key: "bia", name: "Bia", role: "secondary" };
  const lookTiming = timing(0, "look at this price right now");
  const planWith = (actions: readonly ActorAction[]) =>
    planMotion({
      scenes: [
        base(1, {
          purpose: "hook",
          background: "plain",
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "left",
              actions,
            },
            { characterKey: "bia", pose: "neutral", expression: "neutral", position: "right" },
          ],
        }),
      ],
      timings: [lookTiming],
      characters: [alex, bia],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: lookTiming.endMs,
    });
  /** Alex's face features: the first face group drawn after a head circle. */
  const faceAt = (svg: string) =>
    svg
      .match(/r="58"[^>]*\/><g transform="translate\((-?[\d.]+),(-?[\d.]+)\)">/)
      ?.slice(1)
      .map(Number) ?? [];

  it("turns the face toward another actor while breathing, then back", () => {
    const looking = planWith([
      { type: "look_at", atWord: 1, target: { kind: "actor", characterKey: "bia" } },
    ]);
    const still = planWith([]);
    // Word 1 at 700 ms, default 1200 ms: the look holds at 1300 ms and has ended by 2500 ms.
    const [x = 0, y = 0] = faceAt(composeMotionFrame(looking, 1_300));
    const [x0 = 0, y0 = 0] = faceAt(composeMotionFrame(still, 1_300));
    expect(x - x0).toBeGreaterThan(10);
    expect(Math.abs(y - y0)).toBeLessThan(2);
    // A glance is not "acting": breathing (scale) matches the idle actor exactly.
    const scaleOf = (svg: string) => svg.match(/translate\(300,1180\) scale\(([\d.]+)\)/)?.[1];
    expect(scaleOf(composeMotionFrame(looking, 1_300))).toBe(
      scaleOf(composeMotionFrame(still, 1_300)),
    );
    expect(composeMotionFrame(looking, 2_500)).toBe(composeMotionFrame(still, 2_500));
  });
});

describe("camera movements", () => {
  // One hook scene: voice 300 to 2700 ms, on screen until 3100 ms; its hard cut punches until 620 ms.
  const cameraTiming = timing(0, "look at this price right now");
  const planWith = (movement: SceneCamera["movement"], index = 1) =>
    planMotion({
      scenes: [
        base(index, { purpose: "hook", background: "plain", camera: { shot: "medium", movement } }),
      ],
      timings: [cameraTiming],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: cameraTiming.endMs,
    });
  /** The world camera group: its first translate (x, y) and its zoom. */
  const cameraAt = (motion: MotionPlan, t: number) => {
    const match = composeMotionFrame(motion, t).match(
      /<\/defs><rect [^>]*\/><g transform="translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)/,
    );
    return { x: Number(match?.[1]), y: Number(match?.[2]), zoom: Number(match?.[3]) };
  };

  it("pushes in within the first second and holds, well ahead of a slow zoom", () => {
    const push = planWith("push_in");
    expect(cameraAt(push, 700).zoom).toBeGreaterThan(1.12);
    expect(cameraAt(push, 3_000).zoom).toBeCloseTo(1.133, 3);
    expect(cameraAt(push, 1_500).zoom).toBeGreaterThan(
      cameraAt(planWith("slow_zoom_in"), 1_500).zoom + 0.05,
    );
  });

  it("scales a low angle about the ground line and drops the world", () => {
    const low = cameraAt(planWith("low_angle"), 1_500);
    expect(low.zoom).toBeCloseTo(1.1124, 4);
    expect(low.y).toBe(1_220);
    expect(cameraAt(planWith("none"), 1_500).y).toBe(900);
  });

  it("sways a handheld camera a few px, the same on every render and different per scene", () => {
    const hand = planWith("handheld");
    const offsets = Array.from({ length: 70 }, (_, i) => cameraAt(hand, 700 + i * 33));
    expect(offsets.every(({ x, y }) => Math.abs(x - 540) <= 5 && Math.abs(y - 900) <= 5)).toBe(
      true,
    );
    expect(new Set(offsets.map(({ x }) => x)).size).toBeGreaterThan(10);
    expect(cameraAt(planWith("handheld"), 1_500)).toEqual(cameraAt(hand, 1_500));
    expect(cameraAt(planWith("handheld", 2), 1_500)).not.toEqual(cameraAt(hand, 1_500));
  });
});

describe("emote", () => {
  // Word 0 starts at 300 ms; a default 1800 ms emote ends at 2100 ms; the scene ends at 3100 ms.
  const emoteTiming = timing(0, "look at this price right now");
  const planWith = (actions: readonly ActorAction[]) =>
    planMotion({
      scenes: [
        base(1, {
          purpose: "hook",
          background: "plain",
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "center",
              actions,
            },
          ],
        }),
      ],
      timings: [emoteTiming],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: emoteTiming.endMs,
    });
  const still = planWith([]);
  /** Face offset from the head centre, px (rig coordinates, +x toward the facing side). */
  const faceOffset = (svg: string): number => {
    const match = svg.match(
      /<circle cx="(-?[\d.]+)" cy="-?[\d.]+" r="58"[^>]*\/><g transform="translate\((-?[\d.]+),/,
    );
    return Number(match?.[2]) - Number(match?.[1]);
  };

  it("moves the body through start, middle and end, then matches the still actor", () => {
    const frustrated = planWith([{ type: "emote", atWord: 0, emotion: "frustrated" }]);
    for (const t of [500, 1_100, 1_900])
      expect(composeMotionFrame(frustrated, t)).not.toBe(composeMotionFrame(still, t));
    // 600 ms after the end: pose, face, breathing and blinks are the still actor's again.
    expect(composeMotionFrame(frustrated, 2_700)).toBe(composeMotionFrame(still, 2_700));
  });

  it("glances to one side and then the other while searching", () => {
    const searching = planWith([{ type: "emote", atWord: 0, emotion: "searching" }]);
    // Glances hold over 660-1164 ms (stage left) and 1200-1704 ms (stage right).
    expect(faceOffset(composeMotionFrame(searching, 912))).toBeLessThan(-8);
    expect(faceOffset(composeMotionFrame(searching, 1_452))).toBeGreaterThan(8);
    expect(Math.abs(faceOffset(composeMotionFrame(searching, 2_700)))).toBeLessThan(1);
  });

  it("draws every emotion without NaN", () => {
    for (const emotion of EMOTIONS) {
      const emoting = planWith([{ type: "emote", atWord: 0, emotion }]);
      for (let t = 300; t <= 2_200; t += 100)
        expect(composeMotionFrame(emoting, t)).not.toContain("NaN");
    }
  });
});

describe("painted backgrounds", () => {
  const art = { href: "data:image/png;base64,AAAA" };
  const text = "the kitchen at night";
  const painted = (
    backgroundArt: ReadonlyMap<string, { href: string }>,
    movement: SceneCamera["movement"] = "pan_right",
  ) =>
    planMotion({
      scenes: [
        base(1, {
          purpose: "hook",
          backgroundAssetId: "bg-1",
          camera: { shot: "medium", movement },
        }),
      ],
      timings: [timing(0, text)],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timing(0, text).endMs,
      backgroundArt,
    });
  const withArt = painted(new Map([["bg-1", art]]));
  const cameras = (motion: MotionPlan, t: number) => {
    const match = composeMotionFrame(motion, t).match(
      /<g data-art="1" transform="translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)[^>]*><image[^>]*\/><\/g><g transform="translate\((-?[\d.]+),(-?[\d.]+)\) scale\(([\d.]+)\)/,
    );
    const [far, stage] = [match?.slice(1, 4), match?.slice(4, 7)].map((group) => ({
      x: Number(group?.[0]),
      y: Number(group?.[1]),
      zoom: Number(group?.[2]),
    })) as [{ x: number; y: number; zoom: number }, { x: number; y: number; zoom: number }];
    return { far, stage };
  };

  it("draws the painted art under the stage instead of the procedural background", () => {
    const frame = composeMotionFrame(withArt, 500);
    expect(frame).toContain('<image href="data:image/png;base64,AAAA" x="-60" y="-106"');
    expect(frame).not.toContain("data-background=");
    expect(frame.indexOf('data-art="1"')).toBeLessThan(frame.indexOf(",1180)"));
    expect(withArt.notes).toEqual([]);
  });

  it("moves the art at half the camera pan (parallax)", () => {
    const { far, stage } = cameras(withArt, 100);
    expect(stage.x).toBeLessThan(530);
    expect(far.x - 540).toBeCloseTo((stage.x - 540) / 2, 0);
  });

  it("composes with push_in, low_angle and handheld: a far layer that follows by half", () => {
    const push = cameras(painted(new Map([["bg-1", art]]), "push_in"), 1_500);
    expect(push.far.zoom).toBeCloseTo(1 + (push.stage.zoom - 1) / 2, 3);
    const low = cameras(painted(new Map([["bg-1", art]]), "low_angle"), 1_500);
    // Stage drops 40 px about the ground line; the far layer drops half as far, about the same line.
    expect(low.stage.y - low.far.y).toBeGreaterThan(15);
    expect(low.far.zoom).toBeLessThan(low.stage.zoom);
    const hand = painted(new Map([["bg-1", art]]), "handheld");
    for (let t = 700; t < 2_500; t += 97) {
      const { far, stage } = cameras(hand, t);
      expect(far.x - 540).toBeCloseTo((stage.x - 540) / 2, 0);
      expect(far.y - 900).toBeCloseTo((stage.y - 900) / 2, 0);
    }
  });

  it("grounds actors on painted floors with a wider, darker contact shadow", () => {
    expect(composeMotionFrame(withArt, 500)).toContain('fill-opacity="0.24"');
    expect(composeMotionFrame(plan, 500)).not.toContain('fill-opacity="0.24"');
  });

  it("falls back to the procedural setting, and notes it, when the art is missing", () => {
    const missing = painted(new Map());
    expect(missing.notes).toEqual(["background_fallback:1"]);
    expect(composeMotionFrame(missing, 500)).toContain('data-background="store"');
  });

  it("dresses actors from the cast wardrobe in motion and in stills", () => {
    const dressedAlex = {
      ...alex,
      wardrobe: { top: { style: "tshirt" as const, colour: "#2f6fdb" } },
    };
    const dressed = planMotion({
      scenes: [base(1, { purpose: "hook" })],
      timings: [timing(0, "hello there")],
      characters: [dressedAlex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timing(0, "hello there").endMs,
    });
    expect(composeMotionFrame(dressed, 500)).toContain('fill="#2f6fdb"');
    expect(
      composeSceneSvg(base(1, {}), { characters: [dressedAlex], palette: DEFAULT_SCENE_PALETTE }),
    ).toContain('fill="#2f6fdb"');
  });

  it("switches the rig to hand-drawn lines when the plan asks for the sketch style", () => {
    const styled = (lineStyle?: "clean" | "sketch") =>
      planMotion({
        scenes: [base(1, { purpose: "hook" })],
        timings: [timing(0, "hello there")],
        characters: [alex],
        palette: DEFAULT_SCENE_PALETTE,
        captionWords: 3,
        durationMs: timing(0, "hello there").endMs,
        lineStyle,
      });
    expect(styled().lineStyle).toBe("clean");
    expect(composeMotionFrame(styled("sketch"), 500)).toContain('stroke-opacity="0.45"');
    expect(composeMotionFrame(styled("clean"), 500)).toBe(composeMotionFrame(styled(), 500));
  });

  it("cycles an ambient loop on each scene's own clock and wraps past its last frame", () => {
    const looped = painted(
      new Map([
        [
          "bg-1",
          { href: "data:still", loop: { frames: ["data:f0", "data:f1", "data:f2"], fps: 30 } },
        ],
      ]),
    );
    const hrefAt = (t: number) => composeMotionFrame(looped, t).match(/<image href="([^"]+)"/)?.[1];
    expect([0, 34, 67, 100, 134].map(hrefAt)).toEqual([
      "data:f0",
      "data:f1",
      "data:f2",
      "data:f0",
      "data:f1",
    ]);
    // Scene 1 ends at 2300 ms; during scene 2's fade each scene keeps its own loop clock.
    const two = planMotion({
      scenes: [
        base(1, { purpose: "hook", backgroundAssetId: "bg-1" }),
        base(2, { background: "bank", backgroundAssetId: "bg-2", transition: "fade" }),
      ],
      timings: [timing(0, text), timing(2_300, text)],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: timing(2_300, text).endMs,
      backgroundArt: new Map([
        ["bg-1", { href: "data:a", loop: { frames: ["data:a0", "data:a1", "data:a2"], fps: 30 } }],
        ["bg-2", { href: "data:b", loop: { frames: ["data:b0", "data:b1"], fps: 30 } }],
      ]),
    });
    const fading = composeMotionFrame(two, 2_400);
    expect(fading).toContain('href="data:a0"'); // floor(2400 * 0.03) = 72, 72 % 3 = 0
    expect(fading).toContain('href="data:b1"'); // floor(100 * 0.03) = 3, 3 % 2 = 1
  });
});
