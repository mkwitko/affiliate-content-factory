import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { DirectorPlanSegment } from "@money-maker/contracts/scene-spec-schema";
import {
  createSceneSpecSchema,
  sceneDirectorJsonSchema,
} from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import {
  type SceneDirector,
  type SceneDirectorInput,
  STICK_V1_CATALOG,
} from "../explainer/scene-director.js";
import type { SceneSpec } from "../explainer/scene-spec.js";
import { SCENE_PURPOSES } from "../explainer/scene-spec.js";
import {
  checkDirectorOutput,
  copyIntegrityCheck,
  directScenes,
  inventedNumbers,
} from "./direct-scenes.js";
import {
  compileDirectorPlan,
  directorPlanFrom,
  directorSceneBoundaries,
  scriptSegments,
} from "./director-plan.js";
import { createContentScript } from "./editorial.js";

const sentences = [
  "Essa air fryer custa R$ 329,90 hoje.",
  "A Carla comparou três modelos antes de comprar.",
  "No fim, o cesto grande resolveu o jantar da família.",
];
const body = sentences.join(" ");
const alex: ExplainerCharacter = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
};
const draft = createContentScript({
  workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
  contentItemId: "item-1",
  version: 1,
  body,
  language: "pt-BR",
  claims: [
    {
      text: "Preço de R$ 329,90.",
      kind: "verified_fact",
      evidence: [{ kind: "commercial_fact", snapshotId: "snap-1", key: "price" }],
    },
  ],
  beats: [
    { kind: "hook", atChar: 0, label: "money_question" },
    { kind: "payoff", atChar: 90 },
  ],
  actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
});
const input: SceneDirectorInput = {
  script: { ...draft, status: "approved" },
  persona: [alex],
  catalog: STICK_V1_CATALOG,
  timing: [],
};
const starts = sentences.map((sentence) => body.indexOf(sentence));
const CAMERAS = [
  { shot: "medium", movement: "none" },
  { shot: "close", movement: "push_in" },
  { shot: "wide", movement: "slow_zoom_out" },
] as const;
const scene = (index: number, over: Partial<SceneSpec> = {}): SceneSpec => ({
  index,
  fromChar: starts[index - 1] ?? 0,
  toChar: starts[index] ?? body.length,
  purpose: "explanation",
  background: "kitchen",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  // createStoryboard rejects the same shot and move twice in a row (camera_repeated).
  camera: CAMERAS[(index - 1) % CAMERAS.length] as SceneSpec["camera"],
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const good: readonly SceneSpec[] = [
  scene(1, {
    purpose: "hook",
    overlays: [{ text: "R$ 329,90 hoje", position: "top" }],
    actors: [
      {
        characterKey: "alex",
        pose: "pointing",
        expression: "happy",
        position: "center",
        actions: [{ type: "enter", atWord: 0, from: "left", durationMs: 900 }],
      },
    ],
  }),
  scene(2, { background: "store" }),
  scene(3, { purpose: "payoff", props: [{ type: "lightbulb", position: "top" }] }),
];

/** What a model writes for these scenes (segments and word ranges, see director-plan). */
const plan = (scenes: readonly (SceneSpec | undefined)[]) =>
  directorPlanFrom(scenes as readonly SceneSpec[], body);
type PlanVisual = Extract<DirectorPlanSegment, { newScene: true }>["visual"];
const mapVisuals = (
  value: ReturnType<typeof plan>,
  update: (visual: PlanVisual, segmentIndex: number) => PlanVisual,
) => ({
  segments: value.segments.map((entry, segmentIndex) =>
    entry.newScene ? { ...entry, visual: update(entry.visual, segmentIndex) } : entry,
  ),
});

/** Fake director for tests: replays outputs in order; an Error output is thrown. */
const scripted = (...outputs: unknown[]) => {
  const calls: Parameters<SceneDirector["direct"]>[0][] = [];
  const director: SceneDirector = {
    direct: async (call) => {
      calls.push(call);
      const next = outputs.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { director, calls };
};

describe("directScenes", () => {
  it("never lets the director invent a background asset id", async () => {
    const invented = { ...good[0], backgroundAssetId: "bg-made-up" };
    const base = plan(good);
    const bad = mapVisuals(base, (visual, index) =>
      index === 0 ? ({ ...visual, backgroundAssetId: "bg" } as PlanVisual) : visual,
    );
    const { director, calls } = scripted(bad, base);
    const result = await directScenes(director, input);
    expect(result).toMatchObject({ ok: true, attempts: [{ reason: "output_invalid" }] });
    expect(calls[1]?.correction?.errors.join(" ")).toContain("backgroundAssetId");
    // The JSON schema the model is constrained by does not offer the field either.
    const projection = JSON.stringify(
      sceneDirectorJsonSchema(
        { purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG },
        scriptSegments(body).length,
      ),
    );
    expect(projection).not.toContain("backgroundAssetId");
    // The MCP boundary schema does accept it, for painted storyboards.
    expect(
      createSceneSpecSchema({ purposes: SCENE_PURPOSES, ...STICK_V1_CATALOG }).safeParse(invented)
        .success,
    ).toBe(true);
  });

  it("returns the scenes of a valid first answer without a correction", async () => {
    const { director, calls } = scripted(plan(good));
    expect(await directScenes(director, input)).toEqual({ ok: true, scenes: good, attempts: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.correction).toBeUndefined();
  });

  it("retries once with the schema errors and the rejected output", async () => {
    const base = plan(good);
    const bad = mapVisuals(base, (visual, index) =>
      index === 0 ? ({ ...visual, background: "beach" } as PlanVisual) : visual,
    );
    const { director, calls } = scripted(bad, base);
    const result = await directScenes(director, input);
    expect(result).toMatchObject({ ok: true, attempts: [{ reason: "output_invalid" }] });
    expect(calls[1]?.correction?.previous).toBe(bad);
    expect(calls[1]?.correction?.errors[0]).toMatch(/^segments\.0\.visual\.background: /);
  });

  it("gives up after the correction also fails and keeps both attempts", async () => {
    const { director, calls } = scripted("not json", undefined);
    const result = await directScenes(director, input);
    expect(result).toMatchObject({
      ok: false,
      reason: "output_invalid",
      attempts: [{ reason: "output_not_json" }, { reason: "output_invalid" }],
    });
    expect(calls).toHaveLength(2);
  });

  it("does not retry when the director cannot be reached", async () => {
    const { director, calls } = scripted(new Error("fetch failed"));
    expect(await directScenes(director, input)).toEqual({
      ok: false,
      reason: "director_unavailable",
      attempts: [
        {
          reason: "director_unavailable",
          errors: ["fetch failed"],
          issues: [{ code: "director_unavailable", message: "fetch failed" }],
        },
      ],
    });
    expect(calls).toHaveLength(1);
  });

  it("accepts point_at, look_at, emote and motivated camera moves", async () => {
    const rich = [
      scene(1, {
        purpose: "hook",
        props: [{ type: "lightbulb", position: "right" }],
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "center",
            actions: [
              { type: "look_at", atWord: 0, target: { kind: "prop", index: 0 }, durationMs: 600 },
              { type: "point_at", atWord: 1, target: { kind: "prop", index: 0 }, durationMs: 600 },
              { type: "emote", atWord: 5, emotion: "excited", durationMs: 900 },
            ],
          },
        ],
        camera: { shot: "close", movement: "handheld" },
      }),
      good[1],
      good[2],
    ];
    const { director } = scripted(plan(rich));
    expect(await directScenes(director, input)).toMatchObject({ ok: true, attempts: [] });
  });

  it("rejects an action outside the catalog at the schema", async () => {
    const flyer = [
      scene(1, {
        purpose: "hook",
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "center",
            actions: [{ type: "fly", atWord: 0 } as never],
          },
        ],
      }),
      good[1],
      good[2],
    ];
    const { director } = scripted(plan(flyer), plan(flyer));
    const result = await directScenes(director, input);
    expect(result.ok).toBe(false);
    expect(result.attempts[0]?.errors[0]).toMatch(
      /^segments\.0\.visual\.actors\.0\.actions\.0\.type: /,
    );
  });

  it("changes the movement when two consecutive cameras are identical", async () => {
    const base = plan([good[0], { ...good[1], camera: good[0]?.camera }, good[2]] as SceneSpec[]);
    const same = base;
    const { director } = scripted(same);
    const result = await directScenes(director, input);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.scenes[1]?.camera).toEqual({ shot: "medium", movement: "slow_zoom_in" });
  });

  it.each([4, 5, 10, 13])("plans valid ordered boundaries for %i script segments", (count) => {
    const script = Array.from({ length: count }, (_, i) => `Sentence ${i + 1}.`).join(" ");
    const cuts = Array.from({ length: count }, (_, i) => count <= 12 || i < 12);
    const result = directorSceneBoundaries(script, cuts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const source = result.boundaries;
    expect(source).toHaveLength(Math.min(count, 12));
    expect(source[0]?.fromChar).toBe(0);
    expect(source.at(-1)?.toChar).toBe(script.length);
    expect(source.flatMap((part) => part.text).join("")).toBe(script);
    expect(source.every((part, i) => i === 0 || source[i - 1]?.toChar === part.fromChar)).toBe(
      true,
    );
    expect(
      source.every((part, i) => {
        const previous = source[i - 1];
        return (
          i === 0 || (previous !== undefined && previous.lastSegment + 1 === part.firstSegment)
        );
      }),
    ).toBe(true);
    expect(source.length).toBeLessThanOrEqual(count);
    if (count <= 12)
      expect(
        source.every((part, i) => part.firstSegment === i + 1 && part.lastSegment === i + 1),
      ).toBe(true);
    expect(source.at(-1)?.lastSegment).toBe(count);
  });

  it("turns same/new-scene choices into contiguous boundaries", () => {
    const script = "One. Two. Three. Four.";
    const result = directorSceneBoundaries(script, [true, true, false, true]);
    expect(result).toMatchObject({
      ok: true,
      boundaries: [
        { firstSegment: 1, lastSegment: 1 },
        { firstSegment: 2, lastSegment: 3 },
        { firstSegment: 4, lastSegment: 4 },
      ],
    });
  });

  it("rejects more than twelve new-scene decisions", () => {
    const script = Array.from({ length: 13 }, (_, i) => `Sentence ${i + 1}.`).join(" ");
    expect(directorSceneBoundaries(script, Array(13).fill(true))).toMatchObject({
      ok: false,
      issue: { code: "scene_count_out_of_range", expected: "3 to 12", actual: "13" },
    });
  });

  it("compiles visual directions against semantic cut decisions without model indices", () => {
    const visuals = plan(good);
    expect(visuals.segments.every((segment) => !("lastSegment" in segment))).toBe(true);
    expect(compileDirectorPlan(visuals, body)).toMatchObject({ ok: true, scenes: good });
  });

  it("compiles a same-scene choice to the exact joined script range", () => {
    const script = "One. Two. Three. Four.";
    const visuals = plan(good)
      .segments.filter((segment) => segment.newScene)
      .map((segment) => ({ ...segment.visual, overlays: [] }));
    const [first, second, third] = visuals;
    if (!first || !second || !third) throw new Error("director_visual_fixtures_missing");
    const result = compileDirectorPlan(
      {
        segments: [
          { newScene: true, visual: first },
          { newScene: true, visual: second },
          { newScene: false },
          { newScene: true, visual: third },
        ],
      },
      script,
    );
    expect(result).toMatchObject({
      ok: true,
      scenes: [
        { fromChar: 0, toChar: 5 },
        { fromChar: 5, toChar: 17 },
        { fromChar: 17, toChar: script.length },
      ],
    });
  });

  it("adds cuts when the director selects fewer than three scenes", () => {
    const valid = plan(good);
    const tooFew = {
      segments: valid.segments.map((segment, index) =>
        index === 1 ? { newScene: false as const } : segment,
      ),
    };
    const result = checkDirectorOutput(tooFew, input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scenes).toHaveLength(3);
  });

  it("rejects legacy or forged segment indices instead of trusting them", () => {
    const valid = plan(good);
    const raw = {
      segments: valid.segments.map((segment, index) =>
        index === 0 && segment.newScene
          ? { ...segment, visual: { ...segment.visual, lastSegment: 400 } }
          : segment,
      ),
    };
    expect(checkDirectorOutput(raw, input)).toMatchObject({
      ok: false,
      failure: { reason: "output_invalid", issues: [{ field: "segments.0.visual" }] },
    });
  });

  it("copies a short overlay excerpt anchored to a script word", async () => {
    const base = plan(good);
    // Scene 3's anchor selects the literal excerpt "cesto grande".
    const quoted = mapVisuals(base, (visual, index) =>
      index === 0
        ? { ...visual, overlays: [] }
        : index === 2
          ? { ...visual, overlays: [{ anchorWord: "cesto", position: "top" }] }
          : visual,
    );
    const { director } = scripted(quoted);
    const result = await directScenes(director, input);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.scenes[2]?.overlays).toEqual([
      { text: "cesto grande resolveu o", position: "top" },
    ]);
    const outside = mapVisuals(base, (visual, index) =>
      index === 0
        ? { ...visual, overlays: [] }
        : index === 2
          ? { ...visual, overlays: [{ anchorWord: "not-in-script", position: "top" }] }
          : visual,
    );
    const ignored = checkDirectorOutput(outside, input);
    expect(ignored.ok).toBe(true);
    if (ignored.ok) expect(ignored.scenes[2]?.overlays).toEqual([]);
  });

  it("cannot name a character outside the cast: the schema offers only its keys", async () => {
    const stranger = [
      scene(1, {
        purpose: "hook",
        actors: [
          { characterKey: "rafa", pose: "neutral", expression: "neutral", position: "left" },
        ],
      }),
      good[1],
      good[2],
    ];
    const { director } = scripted(plan(stranger), plan(stranger));
    expect((await directScenes(director, input)).attempts[0]).toMatchObject({
      reason: "output_invalid",
      issues: [{ field: "segments.0.visual.actors.0.characterKey" }],
    });
    expect(
      JSON.stringify(
        sceneDirectorJsonSchema(
          {
            ...STICK_V1_CATALOG,
            purposes: SCENE_PURPOSES,
            characterKeys: ["alex"],
          },
          scriptSegments(body).length,
        ),
      ),
    ).toContain('"enum":["alex"]');
  });

  it("cannot write a diagram figure: the schema accepts only a claim reference", () => {
    const written = mapVisuals(plan(good), (visual, index) =>
      index === 0
        ? ({ ...visual, diagram: { kind: "counter", from: 0, to: 299.9, claimRef: 0 } } as never)
        : visual,
    );
    const result = checkDirectorOutput(written, input);
    expect(result).toMatchObject({ ok: false, failure: { reason: "output_invalid" } });
  });

  it("copies a counter figure from the verified claim it references", () => {
    const result = checkDirectorOutput(
      plan([
        { ...good[0], diagram: { kind: "counter", from: 0, to: 1, claimRef: 0 } },
        good[1],
        good[2],
      ] as SceneSpec[]),
      input,
    );
    expect(result.ok && result.scenes[0]?.diagram).toEqual({
      kind: "counter",
      from: 0,
      to: 329.9,
      claimRef: 0,
    });
  });

  it("draws no numeric diagram for a claim that is not a verified fact", () => {
    const call = {
      ...input,
      script: {
        ...input.script,
        claims: [{ text: "Preço de R$ 329,90.", kind: "fictional_example" as const, evidence: [] }],
      },
    };
    const result = checkDirectorOutput(
      plan([
        { ...good[0], diagram: { kind: "counter", from: 0, to: 1, claimRef: 0 } },
        good[1],
        good[2],
      ] as SceneSpec[]),
      call,
    );
    expect(result.ok && result.scenes[0]?.diagram).toBeUndefined();
  });

  it("never calls the director for a script that is not approved", async () => {
    const { director, calls } = scripted(good);
    expect(await directScenes(director, { ...input, script: draft })).toEqual({
      ok: false,
      reason: "script_not_approved",
      attempts: [],
    });
    expect(calls).toHaveLength(0);
  });

  it("does not call the director when fewer than three sentence segments exist", async () => {
    const { director, calls } = scripted(plan(good));
    const shortScript = { ...input, script: { ...input.script, body: "One. Two." } };
    expect(await directScenes(director, shortScript)).toMatchObject({
      ok: false,
      reason: "scene_rejected",
      attempts: [{ issues: [{ code: "scene_count_unavailable", actual: "2" }] }],
    });
    expect(calls).toHaveLength(0);
  });
});

describe("checkDirectorOutput", () => {
  const sameCamera = good[0]?.camera as SceneSpec["camera"];

  it("reports independent problems of different scenes in one attempt", () => {
    const base = plan([
      { ...good[0], diagram: { kind: "before_after", before: "R$ 299,90", after: "R$ 329,90" } },
      { ...good[1], camera: sameCamera },
      good[2],
    ] as SceneSpec[]);
    // Scene 3 asks for a literal excerpt by anchor; quota and length are compiler-owned.
    const many = mapVisuals(base, (visual, index) =>
      index === 2 ? { ...visual, overlays: [{ anchorWord: "cesto", position: "top" }] } : visual,
    );
    const result = checkDirectorOutput(many, input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("guard_rejected");
    expect(result.failure.issues.map((issue) => [issue.sceneIndex, issue.code])).toEqual([
      [1, "number_not_in_script"],
    ]);
    expect(result.failure.errors).toHaveLength(1);
  });
});

describe("action timing in the gate", () => {
  it("repairs an emote that runs past its scene instead of rejecting the storyboard", () => {
    const late = mapVisuals(plan(good), (visual, index) =>
      index === 1
        ? ({
            ...visual,
            actors: [
              {
                characterKey: "alex",
                pose: "neutral",
                expression: "neutral",
                position: "center",
                actions: [{ type: "emote", atWord: 6, emotion: "excited", durationMs: 4_000 }],
              },
            ],
          } as typeof visual)
        : visual,
    );
    const result = checkDirectorOutput(late, input);
    expect(result.ok).toBe(true);
    const emote = result.ok ? result.scenes[1]?.actors[0]?.actions?.[0] : undefined;
    expect(emote).toMatchObject({ type: "emote", atWord: 6 });
    expect((emote as { durationMs?: number } | undefined)?.durationMs).toBeLessThan(4_000);
  });
});

describe("semantic intents in the gate", () => {
  it("points at the emphasized verified number of a number_proof beat", () => {
    const call = {
      ...input,
      script: {
        ...input.script,
        beats: [{ kind: "hook" as const, atChar: 0, label: "number_proof" }],
      },
    };
    const result = checkDirectorOutput(plan(good), call);
    expect(result.ok && result.scenes[0]?.actors[0]?.actions).toContainEqual({
      type: "point_at",
      atWord: 5,
      target: { kind: "overlay", index: 0 },
    });
  });
});

describe("visual uniqueness normalization", () => {
  const still = { shot: "medium", movement: "none" } as const;
  const accepted = (scenes: readonly SceneSpec[], call: SceneDirectorInput = input) => {
    const result = checkDirectorOutput(plan(scenes), call);
    if (!result.ok) throw new Error(result.failure.errors.join("\n"));
    return result.scenes;
  };

  it("compares each camera with the already normalized previous scene", () => {
    const scenes = accepted([
      { ...good[0], camera: still },
      { ...good[1], camera: still },
      { ...good[2], camera: still },
    ] as SceneSpec[]);
    expect(scenes.map((s) => `${s.camera.shot}:${s.camera.movement}`)).toEqual([
      "medium:none",
      "medium:slow_zoom_in",
      "medium:none",
    ]);
  });

  it("prefers a motivated move for a tension scene", () => {
    const scenes = accepted([
      { ...good[0], camera: still },
      { ...good[1], purpose: "escalation", camera: still },
      good[2],
    ] as SceneSpec[]);
    expect(scenes[1]?.camera).toEqual({ shot: "medium", movement: "push_in" });
  });

  it("changes the shot when the catalog has no other movement", () => {
    const call = { ...input, catalog: { ...STICK_V1_CATALOG, cameraMovements: ["none"] as const } };
    const scenes = accepted(
      [
        { ...good[0], camera: still },
        { ...good[1], camera: still },
        { ...good[2], camera: { shot: "wide", movement: "none" } },
      ] as SceneSpec[],
      call,
    );
    expect(scenes.map((s) => s.camera.shot)).toEqual(["medium", "close", "wide"]);
  });

  it("keeps the camera_repeated rule when the catalog offers no alternative", () => {
    const call = {
      ...input,
      catalog: {
        ...STICK_V1_CATALOG,
        cameraMovements: ["none"] as const,
        shots: ["medium"] as const,
      },
    };
    const result = checkDirectorOutput(
      plan([good[0], good[1], good[2]].map((s) => ({ ...s, camera: still })) as SceneSpec[]),
      call,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.failure.issues.map((issue) => issue.code)).toContain("camera_repeated");
  });

  const pointer = {
    characterKey: "alex",
    pose: "pointing",
    expression: "happy",
    position: "center",
  };

  it("moves the actor first when a scene repeats the previous picture", () => {
    const scenes = accepted([
      good[0],
      { ...good[1], background: "kitchen", actors: [pointer] },
      good[2],
    ] as SceneSpec[]);
    expect(scenes[1]?.actors[0]).toMatchObject({ pose: "pointing", position: "left" });
  });

  it("changes the pose, not the position, of an actor that walks", () => {
    const walker = { ...pointer, actions: [{ type: "walk_to", atWord: 1, to: "right" }] };
    const scenes = accepted([
      good[0],
      { ...good[1], background: "kitchen", actors: [walker] },
      good[2],
    ] as SceneSpec[]);
    expect(scenes[1]?.actors[0]).toMatchObject({ pose: "thinking", position: "center" });
  });
});

describe("inventedNumbers", () => {
  it("accepts numbers written in the script in either decimal convention", () => {
    const scenes = [
      scene(1, { overlays: [{ text: "329,90", position: "top" }] }),
      scene(2, { diagram: { kind: "counter", from: 0, to: 329.9, claimRef: 0 } }),
    ];
    expect(inventedNumbers(scenes, body)).toEqual([]);
  });

  it("flags diagram values and labels that are not in the script", () => {
    const scenes = [
      scene(1, { diagram: { kind: "percent", value: 87, label: "87% gostam", claimRef: 0 } }),
    ];
    expect(inventedNumbers(scenes, body)).toEqual([
      "number_not_in_script:1:87",
      "number_not_in_script:1:87",
    ]);
  });
});

describe("copyIntegrityCheck", () => {
  it("accepts script text and catalog labels, case and spacing aside", () => {
    const scenes = [
      scene(1, { overlays: [{ text: "custa  r$ 329,90", position: "top" }] }),
      scene(2, { props: [{ type: "laptop", position: "right", label: "Laptop" }] }),
    ];
    expect(copyIntegrityCheck(scenes, body, ["laptop"])).toEqual([]);
  });

  it("rejects text the script never wrote, after the number guard passes", () => {
    const scenes = [scene(1, { overlays: [{ text: "OFERTA IMPERDÍVEL", position: "top" }] })];
    expect(copyIntegrityCheck(scenes, body)).toEqual(["text_not_in_script:1:OFERTA IMPERDÍVEL"]);
  });

  it("reports only the numbers when both fail", () => {
    const scenes = [scene(1, { overlays: [{ text: "R$ 299,90 agora", position: "top" }] })];
    expect(copyIntegrityCheck(scenes, body)).toEqual(["number_not_in_script:1:299,90"]);
  });
});
