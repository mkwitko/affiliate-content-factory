import { createSceneSpecSchema } from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCENE_PALETTE, type ExplainerCharacter } from "./explainer-context.js";
import { expandToken, MOTION_TOKEN_IDS, MOTION_TOKENS } from "./motion-tokens.js";
import { planMotion } from "./motion/plan.js";
import { STICK_V1_CATALOG } from "./scene-director.js";
import { SCENE_PURPOSES, type SceneSpec, validateSceneSpecs } from "./scene-spec.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const text = Array.from({ length: 14 }, (_, i) => `w${i}`).join(" ");
const scene = (
  tokens: SceneSpec["actors"][number]["motionTokens"],
  index = 1,
  purpose: SceneSpec["purpose"] = "hook",
): SceneSpec => ({
  index,
  fromChar: 0,
  toChar: text.length,
  purpose,
  background: "plain",
  actors: [
    {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "left",
      motionTokens: tokens,
    },
  ],
  props: [{ type: "lightbulb", position: "right" }],
  overlays: [],
  camera: { shot: "medium", movement: index === 1 ? "none" : "slow_zoom_in" },
  transition: "hard_cut",
  captionMode: "word",
});
const validate = (scenes: readonly SceneSpec[]) =>
  validateSceneSpecs({
    scenes,
    characters: [alex],
    claims: [],
    renderer: "stickman_motion",
    language: "en",
    sceneTexts: scenes.map(() => text),
  });
const payoff = { ...scene(undefined, 2, "payoff"), background: "store" as const };

describe("motion tokens", () => {
  it.each(MOTION_TOKEN_IDS.map((id) => [id]))(
    "%s expands to actions the validator accepts",
    (id) => {
      const token = { token: id, atWord: 2, target: { kind: "prop" as const, index: 0 } };
      expect(expandToken(token).length).toBeGreaterThan(0);
      expect(validate([scene([token]), payoff])).toEqual({ ok: true });
    },
  );

  it("rejects an unknown token or version, and a missing target", () => {
    const bad = [
      { token: "MOONWALK", atWord: 1 },
    ] as unknown as SceneSpec["actors"][number]["motionTokens"];
    expect(validate([scene(bad), payoff])).toMatchObject({
      ok: false,
      rejection: { reason: "token_unknown" },
    });
    expect(
      validate([scene([{ token: "POINT_BEAT", atWord: 1, version: 2 }]), payoff]),
    ).toMatchObject({
      ok: false,
      rejection: { reason: "token_unknown" },
    });
    expect(validate([scene([{ token: "POINT_BEAT", atWord: 1 }]), payoff])).toMatchObject({
      ok: false,
      rejection: { reason: "action_target_missing" },
    });
  });

  it("places stages by frame offset after the anchored word", () => {
    const plan = planMotion({
      scenes: [scene([{ token: "POINT_BEAT", atWord: 2, target: { kind: "prop", index: 0 } }])],
      timings: [
        {
          startMs: 0,
          endMs: 6_000,
          voiceStartMs: 200,
          voiceEndMs: 5_800,
          text,
          words: Array.from({ length: 14 }, (_, i) => ({
            text: `w${i}`,
            startMs: 200 + i * 400,
            endMs: 550 + i * 400,
          })),
        },
      ],
      characters: [alex],
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: 3,
      durationMs: 6_000,
    });
    const actions = plan.scenes[0]?.actors[0]?.actions ?? [];
    expect(actions.map((a) => [a.action.type, a.startMs])).toEqual([
      ["look_at", 1_000],
      ["point_at", 1_100],
    ]);
  });

  it("is accepted by the shared schema, which still refuses offsetMs from a caller", () => {
    const schema = createSceneSpecSchema({ purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG });
    const withToken = scene([
      { token: "DOUBLE_TAKE", atWord: 1, target: { kind: "prop", index: 0 } },
    ]);
    expect(schema.safeParse(withToken).success).toBe(true);
    const raw = {
      ...withToken,
      actors: [
        {
          ...withToken.actors[0],
          motionTokens: undefined,
          actions: [{ type: "jump", atWord: 1, offsetMs: 50 }],
        },
      ],
    };
    expect(schema.safeParse(raw).success).toBe(false);
    expect(Object.values(MOTION_TOKENS).every((token) => token.version === 1)).toBe(true);
  });
});
