import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { DirectorPlan, DirectorPlanSegment } from "@money-maker/contracts/scene-spec-schema";
import { describe, expect, it } from "vitest";
import { type SceneDirector, STICK_V1_CATALOG } from "../explainer/scene-director.js";
import type { ScenePurpose } from "../explainer/scene-spec.js";
import { directScenes } from "./direct-scenes.js";
import {
  compileDirectorPlan,
  directorSceneBoundaries,
  normalizeDirectorPlan,
  scriptSegments,
} from "./director-plan.js";
import { createContentScript } from "./editorial.js";

type PlanVisual = Extract<DirectorPlanSegment, { newScene: true }>["visual"];

/** One sentence per scene; `words` sets its length so the merge choice is visible. */
const sentence = (words: number, i: number) =>
  `${Array.from({ length: words - 1 }, (_, j) => `w${i}x${j}`).join(" ")} fim${i}.`;
const bodyOf = (lengths: readonly number[]) => lengths.map(sentence).join(" ");

const BACKGROUNDS = ["kitchen", "store", "street", "office"] as const;
const visual = (purpose: ScenePurpose, i: number): PlanVisual =>
  ({
    purpose,
    background: BACKGROUNDS[i % BACKGROUNDS.length],
    actors: [
      {
        characterKey: "alex",
        pose: "neutral",
        expression: "neutral",
        position: "center",
        actions: [{ type: "pose", pose: "pointing", atWord: 1, durationMs: 400 }],
      },
    ],
    props: [],
    overlays: [{ anchorWord: `fim${i}`, position: "top" }],
    camera: { shot: "medium", movement: i % 2 === 0 ? "none" : "push_in" },
    transition: "hard_cut",
    captionMode: "word",
  }) as unknown as PlanVisual;

/** A plan that cuts at every sentence with these purposes. */
const planOf = (purposes: readonly ScenePurpose[]): DirectorPlan =>
  ({
    segments: purposes.map((purpose, i) => ({ newScene: true, visual: visual(purpose, i) })),
  }) as DirectorPlan;

const purposes = (plan: DirectorPlan) =>
  plan.segments.flatMap((entry) => (entry.newScene ? [entry.visual.purpose] : []));
const cuts = (plan: DirectorPlan) => plan.segments.map((entry) => entry.newScene);
const longestExplanationRun = (plan: DirectorPlan) =>
  purposes(plan).reduce(
    (state, purpose) => {
      const run = purpose === "explanation" ? state.run + 1 : 0;
      return { run, max: Math.max(state.max, run) };
    },
    { run: 0, max: 0 },
  ).max;

const normalize = (lengths: readonly number[], scenePurposes: readonly ScenePurpose[]) => {
  const body = bodyOf(lengths);
  return { body, plan: normalizeDirectorPlan(planOf(scenePurposes), body, STICK_V1_CATALOG) };
};

describe("normalizeDirectorPlan explanation runs", () => {
  it("keeps three explanations in a row untouched", () => {
    const scenePurposes: ScenePurpose[] = [
      "hook",
      "explanation",
      "explanation",
      "explanation",
      "payoff",
    ];
    const { plan } = normalize([5, 5, 5, 5, 5], scenePurposes);
    expect(purposes(plan)).toEqual(scenePurposes);
    expect(cuts(plan)).toEqual([true, true, true, true, true]);
  });

  it("merges the smallest later scene of a four-explanation run into the one before", () => {
    const { plan } = normalize(
      [5, 6, 7, 3, 8, 5],
      ["hook", "explanation", "explanation", "explanation", "explanation", "payoff"],
    );
    // Scene 4 (3 words) is the smallest of the run's later scenes; its cut goes.
    expect(cuts(plan)).toEqual([true, true, true, false, true, true]);
    expect(purposes(plan)).toEqual(["hook", "explanation", "explanation", "explanation", "payoff"]);
  });

  it("brings runs of five and more down to three explanations", () => {
    for (const run of [5, 6, 8]) {
      const { plan } = normalize(
        Array.from({ length: run + 2 }, () => 5),
        ["hook", ...Array.from({ length: run }, () => "explanation" as const), "payoff"],
      );
      expect(longestExplanationRun(plan)).toBe(3);
      expect(purposes(plan)).toEqual([
        "hook",
        "explanation",
        "explanation",
        "explanation",
        "payoff",
      ]);
    }
  });

  it("breaks ties at the earliest scene, the same way every time", () => {
    const lengths = [5, 4, 4, 4, 4, 5];
    const scenePurposes: ScenePurpose[] = [
      "hook",
      "explanation",
      "explanation",
      "explanation",
      "explanation",
      "payoff",
    ];
    const first = normalize(lengths, scenePurposes).plan;
    // Scene 2 opens the run and has no explanation to join; scene 3 is the earliest candidate.
    expect(cuts(first)).toEqual([true, true, false, true, true, true]);
    expect(normalize(lengths, scenePurposes).plan).toEqual(first);
  });

  it("never merges the run's first scene into the non-explanation scene before it", () => {
    const { plan } = normalize(
      [5, 2, 6, 6, 6, 5],
      ["hook", "explanation", "explanation", "explanation", "explanation", "payoff"],
    );
    expect(cuts(plan)[1]).toBe(true);
  });

  it("fixes a run made by a missing hook or payoff without relabeling an explanation", () => {
    const { plan } = normalize(
      [5, 5, 5, 5, 5, 5],
      ["explanation", "explanation", "explanation", "explanation", "explanation", "explanation"],
    );
    const result = purposes(plan);
    expect(result[0]).toBe("hook");
    expect(result.at(-1)).toBe("payoff");
    expect(result.slice(1, -1).every((purpose) => purpose === "explanation")).toBe(true);
    expect(longestExplanationRun(plan)).toBeLessThanOrEqual(3);
  });

  it("keeps the hook first, a payoff, three or more scenes and contiguous coverage", () => {
    const lengths = [5, 3, 9, 2, 7, 4, 6, 5];
    const { body, plan } = normalize(lengths, [
      "hook",
      "explanation",
      "explanation",
      "explanation",
      "explanation",
      "explanation",
      "explanation",
      "payoff",
    ]);
    expect(purposes(plan)[0]).toBe("hook");
    expect(purposes(plan)).toContain("payoff");
    expect(purposes(plan).length).toBeGreaterThanOrEqual(3);
    const boundaries = directorSceneBoundaries(body, cuts(plan));
    if (!boundaries.ok) throw new Error(boundaries.issue.code);
    expect(boundaries.boundaries[0]?.fromChar).toBe(0);
    for (const [i, boundary] of boundaries.boundaries.entries())
      expect(boundary.fromChar).toBe(boundaries.boundaries[i - 1]?.toChar ?? 0);
    expect(boundaries.boundaries.at(-1)?.toChar).toBe(body.length);
    expect(scriptSegments(body)).toHaveLength(lengths.length);
  });

  it("keeps the retained scenes' actions and overlays inside their scenes", () => {
    const { body, plan } = normalize(
      [5, 6, 7, 3, 8, 5],
      ["hook", "explanation", "explanation", "explanation", "explanation", "payoff"],
    );
    const compiled = compileDirectorPlan(plan, body);
    if (!compiled.ok) throw new Error(compiled.issues[0]?.code);
    for (const scene of compiled.scenes) {
      const words = body.slice(scene.fromChar, scene.toChar).split(/\s+/).filter(Boolean).length;
      for (const action of scene.actors.flatMap((actor) => actor.actions ?? []))
        expect(action.atWord).toBeLessThan(words);
    }
    // Scene 3 absorbed scene 4: its own overlay, anchored on its own last word, still resolves.
    const merged = compiled.scenes[2];
    expect(body.slice(merged?.fromChar, merged?.toChar)).toContain("fim2.");
    expect(body.slice(merged?.fromChar, merged?.toChar)).toContain("fim3.");
  });
});

describe("directScenes with a long explanation run", () => {
  const lengths = [6, 6, 6, 6, 6, 6, 6];
  const body = bodyOf(lengths);
  const script = createContentScript({
    workspaceId: parseWorkspaceId("11111111-1111-4111-8111-111111111111"),
    contentItemId: "item-1",
    version: 1,
    body,
    language: "pt-BR",
    claims: [],
    beats: [{ kind: "hook", atChar: 0 }],
    actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
  });

  it("accepts the first generation without a correction round", async () => {
    const calls: unknown[] = [];
    const director: SceneDirector = {
      direct: async (call) => {
        calls.push(call);
        return planOf([
          "hook",
          "explanation",
          "explanation",
          "explanation",
          "explanation",
          "explanation",
          "payoff",
        ]);
      },
    };
    const result = await directScenes(director, {
      script: { ...script, status: "approved" },
      persona: [
        {
          key: "alex",
          name: "Alex",
          role: "main",
          rigId: "stick-v1",
          rigVersion: 1,
          palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
        },
      ],
      catalog: STICK_V1_CATALOG,
      timing: [],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.attempts));
    expect(calls).toHaveLength(1);
    expect(result.attempts).toHaveLength(0);
    expect(result.scenes.map((scene) => scene.purpose)).toEqual([
      "hook",
      "explanation",
      "explanation",
      "explanation",
      "payoff",
    ]);
  });
});
