import { LAYOUT_IDS } from "./layouts.js";
import { SHOT_KINDS } from "./shots.js";
import { MOTION_TOKEN_IDS } from "./motion-tokens.js";
import { describe, expect, it } from "vitest";
import { createSceneSpecSchema } from "@money-maker/contracts/scene-spec-schema";
import { BACKGROUNDS } from "./backgrounds.js";
import { PROPS } from "./props.js";
import { EXPRESSIONS, POSES, STICK_V1_ACTIONS } from "./rigs/stick-v1.js";
import { STICK_V1_CATALOG } from "./scene-director.js";
import { CAMERA_MOVEMENTS, EMOTE_MIN_MS, EMOTIONS, SCENE_PURPOSES } from "./scene-spec.js";

const scene = (actions: readonly unknown[]) => ({
  index: 1,
  fromChar: 0,
  toChar: 10,
  purpose: "hook",
  background: "store",
  actors: [
    { characterKey: "alex", pose: "neutral", expression: "neutral", position: "center", actions },
  ],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
});

describe("STICK_V1_CATALOG", () => {
  it("is exactly what the rig, props and backgrounds support", () => {
    expect(STICK_V1_CATALOG).toEqual({
      actions: STICK_V1_ACTIONS,
      poses: POSES,
      expressions: EXPRESSIONS,
      props: PROPS,
      backgrounds: BACKGROUNDS,
      emotions: EMOTIONS,
      cameraMovements: CAMERA_MOVEMENTS,
      emoteMinMs: EMOTE_MIN_MS,
      motionTokens: MOTION_TOKEN_IDS,
      shots: SHOT_KINDS,
      layouts: LAYOUT_IDS,
    });
  });
});

describe("createSceneSpecSchema", () => {
  const schema = createSceneSpecSchema({ purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG });

  it("accepts a scene built from the catalog", () => {
    expect(schema.safeParse(scene([{ type: "enter", atWord: 0, from: "left" }])).success).toBe(
      true,
    );
  });

  it("accepts the point_at, look_at and emote actions and the motivated camera moves", () => {
    const rich = scene([
      { type: "point_at", atWord: 0, target: { kind: "prop", index: 0 } },
      { type: "look_at", atWord: 3, target: { kind: "actor", characterKey: "bia" } },
      { type: "emote", atWord: 5, emotion: "excited", durationMs: 1_200 },
    ]);
    expect(
      schema.safeParse({ ...rich, camera: { shot: "close", movement: "handheld" } }).success,
    ).toBe(true);
  });

  it("rejects an emote shorter than the minimum and an unknown camera move", () => {
    const short = scene([{ type: "emote", atWord: 0, emotion: "excited", durationMs: 300 }]);
    expect(schema.safeParse(short).error?.issues[0]?.path).toEqual([
      "actors",
      0,
      "actions",
      0,
      "durationMs",
    ]);
    const cam = { ...scene([]), camera: { shot: "wide", movement: "dutch_angle" } };
    expect(schema.safeParse(cam).error?.issues[0]?.path).toEqual(["camera", "movement"]);
  });

  it("rejects an action the rig does not have", () => {
    const result = schema.safeParse(scene([{ type: "fly", atWord: 0 }]));
    expect(result.error?.issues[0]?.path).toEqual(["actors", 0, "actions", 0, "type"]);
  });

  it("rejects actions left out of a narrower catalog", () => {
    const narrow = createSceneSpecSchema({
      purposes: SCENE_PURPOSES,
      ...STICK_V1_CATALOG,
      actions: ["enter", "pose"],
    });
    expect(narrow.safeParse(scene([{ type: "jump", atWord: 0 }])).success).toBe(false);
    expect(
      narrow.safeParse(scene([{ type: "emote", atWord: 0, emotion: "excited" }])).success,
    ).toBe(false);
  });

  it("refuses a catalog action the schema cannot describe", () => {
    expect(() =>
      createSceneSpecSchema({
        purposes: SCENE_PURPOSES,
        ...STICK_V1_CATALOG,
        actions: ["fly"],
      }),
    ).toThrow("scene_catalog_action_unknown");
  });
});
