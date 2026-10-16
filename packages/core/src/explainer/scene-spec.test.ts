import { describe, expect, it } from "vitest";
import type { ExplainerCharacter } from "./explainer-context.js";
import {
  type ActorAction,
  collectSceneSpecIssues,
  type LookTarget,
  type SceneSpec,
  sceneChecksum,
  sceneMotion,
  sceneSpecWarnings,
  sceneWordCount,
  validateSceneSpecs,
} from "./scene-spec.js";

const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
};
const scene = (index: number, over: Partial<SceneSpec> = {}): SceneSpec => ({
  index,
  fromChar: (index - 1) * 10,
  toChar: index * 10,
  purpose: "explanation",
  background: "plain",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  // Consecutive fixture scenes alternate shots so they never repeat a camera (camera_repeated).
  camera: { shot: index % 2 === 0 ? "wide" : "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const good = [
  scene(1, { purpose: "hook" }),
  scene(2, { background: "bank" }),
  scene(3, { purpose: "payoff", props: [{ type: "coin", position: "right" }] }),
];
const check = (scenes: readonly SceneSpec[], claimCount = 1) =>
  validateSceneSpecs({
    scenes,
    characters: [alex],
    claims: Array.from({ length: claimCount }, () => ({ kind: "verified_fact" as const })),
  });

describe("validateSceneSpecs", () => {
  it("keeps painted backgrounds to stickman_motion and counts them in the scene picture", () => {
    const painted = [
      scene(1, { purpose: "hook", backgroundAssetId: "bg-1" }),
      scene(2, { background: "bank" }),
      scene(3, { purpose: "payoff" }),
    ];
    const verdict = (
      scenes: readonly SceneSpec[],
      renderer: "stickman_still" | "stickman_motion",
    ) => validateSceneSpecs({ scenes, characters: [alex], claims: [], renderer });
    expect(verdict(painted, "stickman_motion")).toEqual({ ok: true });
    expect(verdict(painted, "stickman_still")).toEqual({
      ok: false,
      rejection: { index: 1, reason: "background_asset_requires_motion" },
    });
    // Two paintings of one setting are two pictures; without the painting scene 2 repeats scene 1.
    expect(
      verdict(
        [
          scene(1, { purpose: "hook" }),
          scene(2, { backgroundAssetId: "bg-2" }),
          scene(3, { purpose: "payoff" }),
        ],
        "stickman_motion",
      ),
    ).toEqual({ ok: true });
    expect(sceneChecksum({ ...scene(2), backgroundAssetId: undefined })).toBe(
      sceneChecksum(scene(2)),
    );
  });

  it("accepts a valid sequence", () => {
    expect(check(good)).toEqual({ ok: true });
  });

  it("requires a hook first", () => {
    expect(check([scene(1), scene(2, { purpose: "payoff", background: "bank" })])).toEqual({
      ok: false,
      rejection: { index: 1, reason: "purpose_sequence" },
    });
  });

  it("requires a payoff somewhere", () => {
    expect(check([scene(1, { purpose: "hook" }), scene(2, { background: "bank" })])).toEqual({
      ok: false,
      rejection: { index: 1, reason: "purpose_sequence" },
    });
  });

  it("rejects more than three explanations in a row", () => {
    const backgrounds = ["bank", "store", "office", "street"] as const;
    const scenes = [
      scene(1, { purpose: "hook" }),
      ...backgrounds.map((background, i) => scene(i + 2, { background })),
      scene(6, { purpose: "payoff" }),
    ];
    expect(check(scenes)).toEqual({
      ok: false,
      rejection: { index: 5, reason: "purpose_sequence" },
    });
  });

  it("rejects unknown characters", () => {
    const actors = [
      { characterKey: "sam", pose: "neutral", expression: "neutral", position: "left" },
    ] as const;
    expect(check([scene(1, { purpose: "hook", actors }), ...good.slice(1)])).toEqual({
      ok: false,
      rejection: { index: 1, reason: "character_missing" },
    });
  });

  it("rejects diagram numbers without a valid claim", () => {
    const missing = scene(1, {
      purpose: "hook",
      actors: [],
      diagram: { kind: "percent", value: 70, label: "x" },
    });
    const outOfRange = scene(1, {
      purpose: "hook",
      actors: [],
      diagram: { kind: "percent", value: 70, label: "x", claimRef: 3 },
    });
    for (const first of [missing, outOfRange])
      expect(check([first, ...good.slice(1)], 1)).toEqual({
        ok: false,
        rejection: { index: 1, reason: "diagram_number_without_claim" },
      });
  });

  it("rejects diagram numbers backed by anything but a verified fact", () => {
    const first = scene(1, {
      purpose: "hook",
      actors: [],
      diagram: { kind: "counter", from: 0, to: 49, unit: "R$", claimRef: 0 },
    });
    for (const kind of [
      "hypothesis",
      "analogy",
      "fictional_example",
      "reasonable_simplification",
    ] as const)
      expect(
        validateSceneSpecs({
          scenes: [first, ...good.slice(1)],
          characters: [alex],
          claims: [{ kind }],
        }),
      ).toEqual({ ok: false, rejection: { index: 1, reason: "diagram_number_without_claim" } });
  });

  it("rejects two identical consecutive scenes", () => {
    expect(
      check([scene(1, { purpose: "hook" }), scene(2), scene(3, { purpose: "payoff" })]),
    ).toEqual({ ok: false, rejection: { index: 2, reason: "repeated_scene" } });
  });

  it("limits overlays per scene, their length and their share of scenes", () => {
    const three = [1, 2, 3].map(() => ({ text: "x", position: "top" as const }));
    expect(check([scene(1, { purpose: "hook", overlays: three }), ...good.slice(1)])).toEqual({
      ok: false,
      rejection: { index: 1, reason: "too_many_overlays" },
    });
    expect(
      check([
        scene(1, { purpose: "hook", overlays: [{ text: "x".repeat(25), position: "top" }] }),
        ...good.slice(1),
      ]),
    ).toEqual({ ok: false, rejection: { index: 1, reason: "overlay_too_long" } });
    const overlay = [{ text: "WHY?", position: "top" as const }];
    expect(check(good.map((s) => ({ ...s, overlays: overlay })))).toEqual({
      ok: false,
      rejection: { index: 3, reason: "overlay_ratio" },
    });
  });

  it("limits actors and props per scene", () => {
    const actor = {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "left",
    } as const;
    expect(
      check([
        scene(1, { purpose: "hook", actors: [actor, actor, actor, actor] }),
        ...good.slice(1),
      ]),
    ).toEqual({
      ok: false,
      rejection: { index: 1, reason: "actors_limit" },
    });
    const prop = { type: "coin", position: "left" } as const;
    expect(
      check([scene(1, { purpose: "hook", props: [prop, prop, prop, prop] }), ...good.slice(1)]),
    ).toEqual({
      ok: false,
      rejection: { index: 1, reason: "props_limit" },
    });
  });
});

describe("scene helpers", () => {
  it("maps camera movement to renderer motion", () => {
    expect(sceneMotion({ shot: "wide", movement: "slow_zoom_in" })).toBe("ken_burns_in");
    expect(sceneMotion({ shot: "wide", movement: "slow_zoom_out" })).toBe("ken_burns_out");
    expect(sceneMotion({ shot: "wide", movement: "pan_left" })).toBe("pan_left");
    expect(sceneMotion({ shot: "wide", movement: "none" })).toBe("static");
    expect(sceneMotion({ shot: "wide", movement: "push_in" })).toBe("ken_burns_in");
    expect(sceneMotion({ shot: "wide", movement: "low_angle" })).toBe("static");
    expect(sceneMotion({ shot: "wide", movement: "handheld" })).toBe("static");
  });

  it("checksums scenes by content", () => {
    expect(sceneChecksum(good[0] as SceneSpec)).toMatch(/^[a-f0-9]{64}$/);
    expect(sceneChecksum(good[0] as SceneSpec)).toBe(sceneChecksum({ ...(good[0] as SceneSpec) }));
    expect(sceneChecksum(good[0] as SceneSpec)).not.toBe(sceneChecksum(good[1] as SceneSpec));
    const reordered = Object.fromEntries(
      Object.entries(good[0] as SceneSpec).reverse(),
    ) as SceneSpec;
    expect(sceneChecksum(reordered)).toBe(sceneChecksum(good[0] as SceneSpec));
  });
});

describe("character actions", () => {
  // 12 words at 165 wpm: ~4.4 s of narration per scene, ~364 ms per word.
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const withActions = (actions: readonly ActorAction[], over: Partial<SceneSpec> = {}) => [
    scene(1, {
      purpose: "hook",
      actors: [
        {
          characterKey: "alex",
          pose: "neutral",
          expression: "neutral",
          position: "center",
          actions,
        },
      ],
      ...over,
    }),
    scene(2, { background: "bank" }),
    scene(3, { purpose: "payoff", props: [{ type: "coin", position: "right" }] }),
  ];
  const motion = (scenes: readonly SceneSpec[], renderer = "stickman_motion" as const) =>
    validateSceneSpecs({
      scenes,
      characters: [alex],
      claims: [],
      renderer,
      language: "en-US",
      sceneTexts: scenes.map(() => text),
    });
  const rejected = (index: number, reason: string) => ({ ok: false, rejection: { index, reason } });

  it("accepts word-anchored actions the rig supports", () => {
    expect(
      motion(
        withActions([
          { type: "enter", atWord: 0, from: "left" },
          { type: "pose", atWord: 4, pose: "pointing" },
          { type: "expression", atWord: 4, expression: "surprised" },
          { type: "react", atWord: 5, mark: "exclaim" },
          { type: "jump", atWord: 8 },
        ]),
      ),
    ).toEqual({ ok: true });
  });

  it("accepts scenes without actions on both SceneSpec renderers and keeps their checksum", () => {
    expect(motion(good)).toEqual({ ok: true });
    expect(motion(good, "stickman_still" as never)).toEqual({ ok: true });
    const plain = good[1] as SceneSpec;
    const actor = plain.actors[0] as SceneSpec["actors"][number];
    expect(sceneChecksum({ ...plain, actors: [{ ...actor, actions: undefined }] })).toBe(
      sceneChecksum(plain),
    );
  });

  it("rejects actions on the still renderer", () => {
    expect(motion(withActions([{ type: "jump", atWord: 1 }]), "stickman_still" as never)).toEqual(
      rejected(1, "actions_require_motion"),
    );
  });

  it("rejects an action the rig cannot perform", () => {
    expect(motion(withActions([{ type: "moonwalk", atWord: 1 } as never]))).toEqual(
      rejected(1, "action_unsupported"),
    );
  });

  it("rejects an anchor word outside the scene narration", () => {
    expect(motion(withActions([{ type: "jump", atWord: 12 }]))).toEqual(
      rejected(1, "action_word_out_of_range"),
    );
    expect(motion(withActions([{ type: "jump", atWord: 1.5 }]))).toEqual(
      rejected(1, "action_word_out_of_range"),
    );
  });

  it("rejects durations out of range and walks faster than 900 px/s", () => {
    expect(motion(withActions([{ type: "jump", atWord: 1, durationMs: 100 }]))).toEqual(
      rejected(1, "action_duration_invalid"),
    );
    // left (300) to right (780) is 480 px: 400 ms would be 1200 px/s.
    expect(
      motion(
        withActions([{ type: "walk_to", atWord: 1, to: "right", durationMs: 400 }], {
          actors: [
            {
              characterKey: "alex",
              pose: "neutral",
              expression: "neutral",
              position: "left",
              actions: [{ type: "walk_to", atWord: 1, to: "right", durationMs: 400 }],
            },
          ],
        }),
      ),
    ).toEqual(rejected(1, "action_duration_invalid"));
  });

  it("rejects overlapping locomotion, double poses on a word, a late enter and actions after exit", () => {
    expect(
      motion(
        withActions([
          { type: "walk_to", atWord: 1, to: "left", durationMs: 2000 },
          { type: "jump", atWord: 2 },
        ]),
      ),
    ).toEqual(rejected(1, "action_overlap"));
    expect(
      motion(
        withActions([
          { type: "pose", atWord: 3, pose: "pointing" },
          { type: "pose", atWord: 3, pose: "thinking" },
        ]),
      ),
    ).toEqual(rejected(1, "action_overlap"));
    expect(
      motion(
        withActions([
          { type: "jump", atWord: 0 },
          { type: "enter", atWord: 6, from: "left" },
        ]),
      ),
    ).toEqual(rejected(1, "action_overlap"));
    expect(
      motion(
        withActions([
          { type: "exit", atWord: 2, to: "right" },
          { type: "expression", atWord: 9, expression: "happy" },
        ]),
      ),
    ).toEqual(rejected(1, "action_overlap"));
  });

  it("rejects an action that cannot finish before the scene narration ends", () => {
    expect(
      motion(withActions([{ type: "walk_to", atWord: 10, to: "left", durationMs: 3000 }])),
    ).toEqual(rejected(1, "action_exceeds_scene"));
  });

  it("limits actions per actor", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      type: "expression" as const,
      atWord: i,
      expression: "happy" as const,
    }));
    expect(motion(withActions(many))).toEqual(rejected(1, "actions_limit"));
  });

  it("counts narration words: letters and digits, apostrophes inside a word", () => {
    expect(sceneWordCount("Why is milk — always — at the back? 100%!")).toBe(8);
    expect(sceneWordCount("It's designed, you didn’t plan it.")).toBe(6);
  });

  it("accepts point_at aimed at a prop, the diagram or an overlay of the same scene", () => {
    const withTargets: Partial<SceneSpec> = {
      props: [{ type: "coin", position: "right" }],
      overlays: [{ text: "WHY?", position: "top" }],
      diagram: { kind: "before_after", before: "Door", after: "Back" },
    };
    for (const target of [
      { kind: "prop", index: 0 },
      { kind: "diagram" },
      { kind: "overlay", index: 0 },
    ] as const)
      expect(motion(withActions([{ type: "point_at", atWord: 2, target }], withTargets))).toEqual({
        ok: true,
      });
  });

  it("rejects point_at when its target is not in the scene", () => {
    for (const target of [
      { kind: "prop", index: 1 },
      { kind: "prop", index: 0.5 },
      { kind: "diagram" },
      { kind: "overlay", index: 0 },
    ] as const)
      expect(
        motion(
          withActions([{ type: "point_at", atWord: 2, target }], {
            props: [{ type: "coin", position: "right" }],
          }),
        ),
      ).toEqual(rejected(1, "action_target_missing"));
  });

  it("rejects point_at overlapping a walk, a jump, a pose or another point_at, and accepts it after a pose settles", () => {
    const props: Partial<SceneSpec> = { props: [{ type: "coin", position: "right" }] };
    // Word 2 starts at ~727 ms; the default 1200 ms runs to ~1927 ms.
    const point: ActorAction = { type: "point_at", atWord: 2, target: { kind: "prop", index: 0 } };
    for (const other of [
      { type: "walk_to", atWord: 1, to: "left", durationMs: 1_000 },
      { type: "jump", atWord: 3 },
      { type: "pose", atWord: 3, pose: "thinking" },
      { type: "point_at", atWord: 4, target: { kind: "prop", index: 0 } },
    ] as const)
      expect(motion(withActions([point, other], props))).toEqual(rejected(1, "action_overlap"));
    // A pose at word 0 settles by 450 ms, before the point starts.
    expect(
      motion(withActions([{ type: "pose", atWord: 0, pose: "thinking" }, point], props)),
    ).toEqual({ ok: true });
  });

  it("accepts look_at at a scene target or another actor, and rejects itself, absent actors and overlapping looks", () => {
    const bia: ExplainerCharacter = { ...alex, key: "bia", name: "Bia", role: "secondary" };
    const look = (target: LookTarget, atWord = 2): ActorAction => ({
      type: "look_at",
      atWord,
      target,
    });
    const verdict = (actions: readonly ActorAction[]) =>
      validateSceneSpecs({
        scenes: [
          scene(1, {
            purpose: "hook",
            props: [{ type: "coin", position: "right" }],
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
          scene(2, { background: "bank" }),
          scene(3, { purpose: "payoff", props: [{ type: "coin", position: "right" }] }),
        ],
        characters: [alex, bia],
        claims: [],
        renderer: "stickman_motion",
        language: "en-US",
        sceneTexts: [text, text, text],
      });
    expect(verdict([look({ kind: "actor", characterKey: "bia" })])).toEqual({ ok: true });
    // A glance combines with walking.
    expect(
      verdict([look({ kind: "prop", index: 0 }), { type: "walk_to", atWord: 2, to: "center" }]),
    ).toEqual({ ok: true });
    for (const target of [
      { kind: "actor", characterKey: "alex" },
      { kind: "actor", characterKey: "rafa" },
      { kind: "diagram" },
    ] as const)
      expect(verdict([look(target)])).toEqual(rejected(1, "action_target_missing"));
    expect(
      verdict([look({ kind: "prop", index: 0 }), look({ kind: "actor", characterKey: "bia" }, 4)]),
    ).toEqual(rejected(1, "action_overlap"));
  });

  it("accepts an emote alone and rejects one that overlaps any other action of the actor", () => {
    const props: Partial<SceneSpec> = { props: [{ type: "coin", position: "right" }] };
    // Word 1 starts at ~364 ms; the default 1800 ms runs to ~2164 ms.
    const emote: ActorAction = { type: "emote", atWord: 1, emotion: "frustrated" };
    expect(motion(withActions([emote], props))).toEqual({ ok: true });
    // A pose at word 8 (~2909 ms) starts after the emote ends.
    expect(
      motion(withActions([emote, { type: "pose", atWord: 8, pose: "thinking" }], props)),
    ).toEqual({ ok: true });
    for (const other of [
      { type: "expression", atWord: 2, expression: "happy" },
      { type: "look_at", atWord: 3, target: { kind: "prop", index: 0 } },
      { type: "walk_to", atWord: 0, to: "left", durationMs: 1_000 },
      { type: "emote", atWord: 4, emotion: "excited" },
    ] as const)
      expect(motion(withActions([emote, other], props))).toEqual(rejected(1, "action_overlap"));
  });

  it("rejects an emote too short for a start, a middle and an end, or with an unknown emotion", () => {
    const emote = (over: Record<string, unknown>) =>
      withActions([{ type: "emote", atWord: 1, emotion: "worried", ...over } as ActorAction]);
    expect(motion(emote({ durationMs: 800 }))).toEqual(rejected(1, "action_duration_invalid"));
    expect(motion(emote({ durationMs: 900 }))).toEqual({ ok: true });
    expect(motion(emote({ emotion: "bored" }))).toEqual(rejected(1, "action_unsupported"));
  });
});

describe("direction rules", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  const directed = (
    scenes: readonly SceneSpec[],
    renderer: "stickman_still" | "stickman_motion" = "stickman_motion",
  ) =>
    validateSceneSpecs({
      scenes,
      characters: [alex],
      claims: [],
      renderer,
      language: "en-US",
      sceneTexts: scenes.map(() => text),
    });
  const pushIn = { shot: "medium", movement: "push_in" } as const;
  const repeated = [
    scene(1, { purpose: "hook", camera: pushIn }),
    scene(2, { background: "bank", camera: pushIn }),
    scene(3, { purpose: "payoff", props: [{ type: "coin", position: "right" }] }),
  ];

  it("rejects the same shot and movement on consecutive stickman_motion scenes", () => {
    expect(directed(repeated)).toEqual({
      ok: false,
      rejection: { index: 2, reason: "camera_repeated" },
    });
    // The same shot with another movement, or the same movement with another shot, is a new picture.
    for (const camera of [
      { shot: "medium", movement: "handheld" },
      { shot: "close", movement: "push_in" },
    ] as const)
      expect(
        directed([
          repeated[0] as SceneSpec,
          scene(2, { background: "bank", camera }),
          repeated[2] as SceneSpec,
        ]),
      ).toEqual({ ok: true });
  });

  it("keeps accepting repeated cameras on stickman_still, where several moves render alike", () => {
    expect(directed(repeated, "stickman_still")).toEqual({ ok: true });
  });

  it("warns when a scene narrates more than 6 s with no cut and no action starting", () => {
    // 20 words at 165 wpm: ~7.3 s. The 12-word scenes run ~4.4 s.
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    // Only the stretch rule is under test here; slice 16 budget warnings have their own tests.
    const warn = (actions: readonly ActorAction[], texts: readonly string[] = [text, long, text]) =>
      sceneSpecWarnings({
        scenes: [
          scene(1, { purpose: "hook" }),
          scene(2, {
            background: "bank",
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
          scene(3, { purpose: "payoff" }),
        ],
        language: "en-US",
        sceneTexts: texts,
      }).filter((warning) => warning.startsWith("static_stretch:"));
    expect(warn([])).toEqual(["static_stretch:2"]);
    // An action halfway through splits the stretch into two ~3.6 s halves.
    expect(warn([{ type: "jump", atWord: 10 }])).toEqual([]);
    // An action on the first word does not help: the scene is static for ~7 s after it.
    expect(warn([{ type: "jump", atWord: 0 }])).toEqual(["static_stretch:2"]);
    // A scene with no spoken words never warns.
    expect(warn([], [text, "", text])).toEqual([]);
  });
});

describe("collectSceneSpecIssues", () => {
  const stickman = (scenes: readonly SceneSpec[]) =>
    collectSceneSpecIssues({
      scenes,
      characters: [alex],
      claims: [],
      renderer: "stickman_motion",
    });
  const bad = [
    scene(1, { purpose: "hook" }),
    scene(2, {
      actors: [1, 2, 3, 4].map(() => ({
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
      })),
    }),
    scene(3, {
      background: "bank",
      camera: { shot: "wide", movement: "none" },
    }),
    scene(4, {
      purpose: "payoff",
      camera: { shot: "medium", movement: "none" },
      overlays: [{ text: "x".repeat(30), position: "top" }],
    }),
  ];

  it("returns three independent problems from different scenes in one pass", () => {
    const issues = stickman(bad);
    expect(issues.map((issue) => [issue.sceneIndex, issue.code])).toEqual([
      [2, "actors_limit"],
      [3, "camera_repeated"],
      [4, "overlay_too_long"],
    ]);
    expect(issues[0]).toMatchObject({
      field: "actors",
      expected: "at most 3",
      actual: "4",
    });
    expect(issues[1]).toMatchObject({
      field: "camera",
      expected: "differs from scene 2",
      actual: "wide:none",
    });
  });

  it("does not repeat a problem that follows from another in the same scene", () => {
    const ghost = scene(2, {
      actors: [
        {
          characterKey: "ghost",
          pose: "neutral",
          expression: "neutral",
          position: "center",
          actions: [{ type: "jump", atWord: 99 }],
        },
      ],
    });
    const codes = stickman([good[0] as SceneSpec, ghost, good[2] as SceneSpec]).map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(["character_missing"]);
  });

  it("reports an explanation run once and keeps validateSceneSpecs on the first issue", () => {
    const run = [
      scene(1, { purpose: "hook" }),
      ...[2, 3, 4, 5, 6].map((i) => scene(i)),
      scene(7, { purpose: "payoff" }),
    ];
    const issues = stickman(run).filter((issue) => issue.code === "purpose_sequence");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.sceneIndex).toBe(5);
    const first = collectSceneSpecIssues({
      scenes: bad,
      characters: [alex],
      claims: [],
      renderer: "stickman_motion",
    })[0];
    expect(
      validateSceneSpecs({
        scenes: bad,
        characters: [alex],
        claims: [],
        renderer: "stickman_motion",
      }),
    ).toEqual({
      ok: false,
      rejection: { index: first?.sceneIndex, reason: first?.code },
    });
  });
});
