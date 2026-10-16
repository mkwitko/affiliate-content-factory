import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirectScenesResult } from "@money-maker/core/content/direct-scenes";
import type { SceneDirectorFixture } from "@money-maker/core/explainer/fixtures/scene-director/fixtures";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { describe, expect, it } from "vitest";
import {
  automaticEntryGate,
  type DirectorRun,
  directorCaseResult,
  expectationMisses,
  readDirectorBenchCandidates,
  readFixtureFile,
  summarizeDirectorRuns,
} from "./director-bench.js";

const fixture = (over: Partial<SceneDirectorFixture> = {}): SceneDirectorFixture => ({
  id: "t02",
  class: "walk_to_object",
  case: "approved",
  source: "synthetic",
  language: "pt-BR",
  body: "x",
  claims: [],
  beats: [],
  cast: ["alex"],
  expected: { validator: "pass", requireActions: ["walk_to"], requireProps: ["milk_carton"] },
  ...over,
});
const scene: SceneSpec = {
  index: 1,
  fromChar: 0,
  toChar: 1,
  purpose: "hook",
  background: "store",
  actors: [
    {
      characterKey: "alex",
      pose: "neutral",
      expression: "neutral",
      position: "center",
      actions: [{ type: "walk_to", atWord: 0, to: "right" }],
    },
  ],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
};
const run = (result: DirectScenesResult, latencyMs = 100): DirectorRun => ({
  fixture: fixture(),
  result,
  latencyMs,
});

describe("expectationMisses", () => {
  it("names what the fixture required and the scenes lack", () => {
    expect(expectationMisses(fixture(), [scene])).toEqual(["missing_prop:milk_carton"]);
    expect(
      expectationMisses(fixture({ expected: { validator: "pass", minActorsInOneScene: 2 } }), [
        scene,
      ]),
    ).toEqual(["actors_below:2"]);
  });
});

describe("summarizeDirectorRuns", () => {
  const runs = [
    run({ ok: true, scenes: [scene], attempts: [] }, 100),
    run(
      {
        ok: true,
        scenes: [scene],
        attempts: [
          {
            reason: "output_invalid",
            errors: ["0.background: Invalid option"],
            issues: [{ code: "output_invalid", field: "0.background", message: "Invalid option" }],
          },
        ],
      },
      300,
    ),
    run(
      {
        ok: false,
        reason: "guard_rejected",
        attempts: [
          {
            reason: "output_not_json",
            errors: ["output is not the requested JSON"],
            issues: [{ code: "output_not_json", message: "output is not the requested JSON" }],
          },
          {
            reason: "guard_rejected",
            errors: ["scene 1 text [number_not_in_script]: Remove the number"],
            issues: [
              { code: "number_not_in_script", sceneIndex: 1, field: "text", message: "Remove" },
            ],
          },
        ],
      },
      500,
    ),
    run(
      {
        ok: false,
        reason: "director_unavailable",
        attempts: [
          {
            reason: "director_unavailable",
            errors: ["fetch failed"],
            issues: [{ code: "director_unavailable", message: "fetch failed" }],
          },
        ],
      },
      5,
    ),
  ];

  it("computes the automatic spec 5.7.4 metrics per attempt and per run", () => {
    expect(summarizeDirectorRuns(runs)).toMatchObject({
      runs: 4,
      jsonValidRate: 0.8,
      zodPassRate: 0.6,
      sceneValidatorPassRate: 0.6,
      finalOkRate: 0.5,
      noRetrySuccessRate: 0.25,
      directorUnavailable: 1,
      invalidAssetReferences: 1,
      unsupportedActions: 0,
      wrongWordAnchors: 0,
      copyChanges: 1,
      expectationMisses: ["t02:missing_prop:milk_carton", "t02:missing_prop:milk_carton"],
      latencyMs: { p50: 100, max: 500 },
    });
  });

  it("reports repairs, errors by code, invalid scenes, time and failure kinds", () => {
    const summary = summarizeDirectorRuns(runs);
    expect(summary).toMatchObject({
      acceptedFirstGeneration: 1,
      acceptedAfterRepair1: 1,
      meanRepairsAmongAccepted: 0.5,
      invalidJson: 1,
      scriptMutations: 0,
      errorsByCode: {
        output_invalid: 1,
        output_not_json: 1,
        number_not_in_script: 1,
        director_unavailable: 1,
      },
      invalidScenesPerFixture: { t02: 0 },
      latencyMs: { total: 905, perStoryboard: 226 },
    });
    const multi = run({
      ok: false,
      reason: "scene_rejected",
      attempts: [
        {
          reason: "scene_rejected",
          errors: ["a", "b", "c"],
          issues: [
            { code: "camera_repeated", sceneIndex: 2, message: "m" },
            { code: "props_limit", sceneIndex: 2, message: "m" },
            { code: "actors_limit", sceneIndex: 5, message: "m" },
            { code: "storyboard_coverage_invalid", message: "m" },
          ],
        },
      ],
    });
    expect(summarizeDirectorRuns([multi])).toMatchObject({
      invalidScenesPerFixture: { t02: 2 },
      scriptMutations: 1,
    });
  });

  it("counts rejected camera repeats", () => {
    const repeated = run({
      ok: false,
      reason: "scene_rejected",
      attempts: [
        {
          reason: "scene_rejected",
          errors: ["scene 2 camera [camera_repeated]: Change the camera"],
          issues: [{ code: "camera_repeated", sceneIndex: 2, field: "camera", message: "Change" }],
        },
      ],
    });
    expect(summarizeDirectorRuns([repeated])).toMatchObject({ cameraRepeated: 1 });
  });

  it("opens the automatic entry gate only for production held-out scripts with no misses", () => {
    const clean = summarizeDirectorRuns([
      {
        fixture: fixture({ source: "production:script-1", expected: { validator: "pass" } }),
        result: { ok: true, scenes: [scene], attempts: [] },
        latencyMs: 1,
      },
    ]);
    expect(
      Object.values(
        automaticEntryGate("holdout", [fixture({ source: "production:script-1" })], clean),
      ).every(Boolean),
    ).toBe(true);
    expect(automaticEntryGate("holdout", [fixture()], clean).productionScripts).toBe(false);
    expect(
      automaticEntryGate("holdout", [fixture({ source: "production:script-1" }), fixture()], clean)
        .productionScripts,
    ).toBe(false);
  });

  it("reads the synthetic sets and a custom fixtures directory", async () => {
    const synthetic = await readFixtureFile(
      new URL("../../../../packages/core/src/explainer/fixtures/scene-director", import.meta.url)
        .pathname,
      "holdout",
    );
    expect(synthetic.split).toBe("holdout");
    expect(synthetic.fixtures.length).toBeGreaterThan(0);
    const dir = await mkdtemp(join(tmpdir(), "director-bench-"));
    await mkdir(join(dir, "holdout"));
    const custom = {
      split: "holdout",
      characters: [],
      fixtures: [fixture({ source: "production:s1" })],
    };
    await writeFile(join(dir, "holdout", "fixtures.json"), JSON.stringify(custom));
    expect(await readFixtureFile(dir, "holdout")).toEqual(custom);
  });
});

describe("director candidate comparison", () => {
  it("uses the existing endpoint by default and accepts explicit candidate endpoints", () => {
    expect(
      readDirectorBenchCandidates({
        SCENE_DIRECTOR_URL: "http://127.0.0.1:8080",
        SCENE_DIRECTOR_MODEL: "baseline",
      }),
    ).toEqual([
      {
        baseUrl: "http://127.0.0.1:8080",
        model: "baseline",
        runtime: "llama.cpp",
        quantization: null,
        temperature: 0,
      },
    ]);
    expect(
      readDirectorBenchCandidates({
        SCENE_DIRECTOR_TEMPERATURE: "0.3",
        DIRECTOR_BENCH_CANDIDATES: JSON.stringify([
          {
            baseUrl: "http://127.0.0.1:8080",
            model: "m",
            runtime: "llama.cpp",
            quantization: null,
          },
        ]),
      }),
    ).toMatchObject([{ temperature: 0.3 }]);
    expect(
      readDirectorBenchCandidates({
        DIRECTOR_BENCH_CANDIDATES: JSON.stringify([
          {
            baseUrl: "http://127.0.0.1:8080",
            model: "baseline",
            runtime: "llama.cpp",
            quantization: "Q4_K_M",
          },
          {
            baseUrl: "http://127.0.0.1:8081",
            model: "challenger",
            runtime: "llama.cpp",
            quantization: "Q6_K",
          },
        ]),
      }),
    ).toHaveLength(2);
    expect(() =>
      readDirectorBenchCandidates({ DIRECTOR_BENCH_CANDIDATES: '[{"model":"missing-url"}]' }),
    ).toThrow();
  });

  it("records comparable case facts without inventing subjective scores", () => {
    const candidate = {
      baseUrl: "http://127.0.0.1:8080",
      model: "baseline",
      runtime: "llama.cpp",
      quantization: "Q4_K_M",
      temperature: 0,
    };
    expect(
      directorCaseResult(candidate, run({ ok: true, scenes: [scene], attempts: [] }, 42)),
    ).toMatchObject({
      model: "baseline",
      runtime: "llama.cpp",
      quantization: "Q4_K_M",
      case_id: "t02",
      schema_valid: true,
      accepted: true,
      retry_count: 0,
      latency_ms: 42,
      output_tokens: null,
      story_coherence: null,
      product_visibility: null,
      validation_failures: ["missing_prop:milk_carton"],
    });
  });
});
