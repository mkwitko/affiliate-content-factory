import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DirectFailureReason,
  type DirectScenesResult,
  directScenes,
} from "@money-maker/core/content/direct-scenes";
import {
  fixtureInput,
  type SceneDirectorFixture,
  type SceneDirectorFixtureFile,
} from "@money-maker/core/explainer/fixtures/scene-director/fixtures";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import {
  createLlamaServerSceneDirector,
  identifyLlamaServerModel,
  readSceneDirectorConfig,
  readSceneDirectorTemperature,
} from "@money-maker/providers/llm/llama-server-scene-director";

/**
 * Runs the scene director fixtures (spec 5.7.4) against a local llama-server and prints the
 * automatic metrics. Human metrics (editorial approval, fix time, final video quality, blind
 * comparison with the ChatGPT storyboard) are listed, not computed. Never wired into the queue.
 */
export type DirectorRun = Readonly<{
  fixture: SceneDirectorFixture;
  result: DirectScenesResult;
  latencyMs: number;
}>;

type Candidate = Readonly<{
  baseUrl: string;
  model: string;
  runtime: string;
  quantization: string | null;
  timeoutMs?: number;
  temperature: number;
}>;

export const readDirectorBenchCandidates = (
  env: Readonly<Record<string, string | undefined>>,
): readonly Candidate[] => {
  const fallback = readSceneDirectorConfig(env);
  const temperature = readSceneDirectorTemperature(env);
  if (!env.DIRECTOR_BENCH_CANDIDATES) {
    if (!fallback) throw new Error("SCENE_DIRECTOR_URL is not set");
    return [{ ...fallback, runtime: "llama.cpp", quantization: null }];
  }
  let value: unknown;
  try {
    value = JSON.parse(env.DIRECTOR_BENCH_CANDIDATES);
  } catch {
    throw new Error("director_bench_candidates_invalid");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 8)
    throw new Error("director_bench_candidates_invalid");
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("baseUrl" in item) ||
      typeof item.baseUrl !== "string" ||
      !("model" in item) ||
      typeof item.model !== "string" ||
      !("runtime" in item) ||
      typeof item.runtime !== "string" ||
      !("quantization" in item) ||
      (item.quantization !== null && typeof item.quantization !== "string")
    )
      throw new Error("director_bench_candidates_invalid");
    return {
      baseUrl: item.baseUrl,
      model: item.model,
      runtime: item.runtime,
      quantization: item.quantization,
      ...(fallback?.timeoutMs ? { timeoutMs: fallback.timeoutMs } : {}),
      temperature,
    };
  });
};

export const directorCaseResult = (candidate: Candidate, run: DirectorRun) => ({
  model: candidate.model,
  runtime: candidate.runtime,
  quantization: candidate.quantization,
  case_id: run.fixture.id,
  schema_valid:
    run.result.ok ||
    !run.result.attempts.some(
      (attempt) => attempt.reason === "output_not_json" || attempt.reason === "output_invalid",
    ),
  accepted: run.result.ok,
  retry_count: run.result.attempts.length,
  latency_ms: run.latencyMs,
  output_tokens: null,
  story_coherence: null,
  scene_continuity: null,
  visual_specificity: null,
  product_visibility: null,
  character_consistency: null,
  commercial_intent: null,
  validation_failures: [
    ...run.result.attempts.flatMap((attempt) => attempt.issues.map((issue) => issue.code)),
    ...(run.result.ok ? expectationMisses(run.fixture, run.result.scenes) : []),
  ],
});

export const expectationMisses = (
  fixture: SceneDirectorFixture,
  scenes: readonly SceneSpec[],
): readonly string[] => {
  const actors = scenes.flatMap((scene) => scene.actors);
  const actions = actors.flatMap((actor) => actor.actions ?? []);
  const types = new Set(actions.map((action) => action.type));
  const poses = new Set([
    ...actors.map((actor) => actor.pose),
    ...actions.flatMap((action) => (action.type === "pose" ? [action.pose] : [])),
  ]);
  const props = new Set(scenes.flatMap((scene) => scene.props.map((prop) => prop.type)));
  const most = Math.max(0, ...scenes.map((scene) => scene.actors.length));
  const { expected } = fixture;
  return [
    ...(expected.requireActions ?? [])
      .filter((type) => !types.has(type))
      .map((t) => `missing_action:${t}`),
    ...(expected.requirePoses ?? [])
      .filter((pose) => !poses.has(pose))
      .map((p) => `missing_pose:${p}`),
    ...(expected.requireProps ?? [])
      .filter((prop) => !props.has(prop))
      .map((p) => `missing_prop:${p}`),
    ...(expected.minActorsInOneScene !== undefined && most < expected.minActorsInOneScene
      ? [`actors_below:${expected.minActorsInOneScene}`]
      : []),
  ];
};

const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;
const SCRIPT_MUTATION = new Set(["storyboard_coverage_invalid", "storyboard_invalid"]);

export const summarizeDirectorRuns = (runs: readonly DirectorRun[]) => {
  const attempts = runs.flatMap((run) => run.result.attempts);
  const by = (reason: DirectFailureReason): number =>
    attempts.filter((attempt) => attempt.reason === reason).length;
  const successes = runs.filter((run) => run.result.ok).length;
  // Attempts that produced output (a success is one attempt that is not in `attempts`).
  const produced =
    attempts.length - by("director_unavailable") - by("script_not_approved") + successes;
  const notJson = by("output_not_json");
  const zod = by("output_invalid");
  const rejected = by("scene_rejected");
  const issues = attempts.flatMap((attempt) => attempt.issues);
  const count = (match: (code: string, field: string) => boolean): number =>
    issues.filter((issue) => match(issue.code, issue.field ?? "")).length;
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);
  const accepted = runs.filter((run) => run.result.ok);
  const errorsByCode: Record<string, number> = {};
  for (const issue of issues) errorsByCode[issue.code] = (errorsByCode[issue.code] ?? 0) + 1;
  const totalMs = latencies.reduce((sum, ms) => sum + ms, 0);
  return {
    runs: runs.length,
    jsonValidRate: rate(produced - notJson, produced),
    zodPassRate: rate(produced - notJson - zod, produced),
    sceneValidatorPassRate: rate(produced - notJson - zod - rejected, produced),
    finalOkRate: rate(successes, runs.length),
    noRetrySuccessRate: rate(
      runs.filter((run) => run.result.ok && run.result.attempts.length === 0).length,
      runs.length,
    ),
    acceptedFirstGeneration: accepted.filter((run) => run.result.attempts.length === 0).length,
    acceptedAfterRepair1: accepted.filter((run) => run.result.attempts.length === 1).length,
    meanRepairsAmongAccepted:
      accepted.length === 0
        ? null
        : Math.round(
            (accepted.reduce((sum, run) => sum + run.result.attempts.length, 0) / accepted.length) *
              1000,
          ) / 1000,
    errorsByCode,
    /** Distinct scenes with an issue in the first attempt, per fixture (0 when it passed). */
    invalidScenesPerFixture: Object.fromEntries(
      runs.map((run) => [
        run.fixture.id,
        new Set(
          (run.result.attempts[0]?.issues ?? []).flatMap((issue) =>
            issue.sceneIndex === undefined ? [] : [issue.sceneIndex],
          ),
        ).size,
      ]),
    ),
    invalidJson: notJson,
    scriptMutations: attempts.filter((attempt) =>
      attempt.issues.some((issue) => SCRIPT_MUTATION.has(issue.code)),
    ).length,
    directorUnavailable: by("director_unavailable"),
    invalidAssetReferences: count(
      (code, field) =>
        code === "output_invalid" && /(?:^|\.)(?:background|icon|props\.\d+\.type)$/.test(field),
    ),
    unsupportedActions: count(
      (code, field) =>
        code === "action_unsupported" ||
        (code === "output_invalid" && /actions\.\d+\.type$/.test(field)),
    ),
    wrongWordAnchors: count(
      (code) => code === "action_word_out_of_range" || code === "action_exceeds_scene",
    ),
    copyChanges: count((code) => code === "number_not_in_script"),
    cameraRepeated: count((code) => code === "camera_repeated"),
    expectationMisses: runs.flatMap((run) =>
      run.result.ok
        ? expectationMisses(run.fixture, run.result.scenes).map(
            (miss) => `${run.fixture.id}:${miss}`,
          )
        : [],
    ),
    latencyMs: {
      p50: latencies[Math.floor((latencies.length - 1) / 2)] ?? null,
      max: latencies.at(-1) ?? null,
      total: totalMs,
      perStoryboard: runs.length === 0 ? null : Math.round(totalMs / runs.length),
    },
    manual: [
      "editorial approval rate",
      "manual fix time",
      "final video quality",
      "peak RAM and VRAM (director-b3.sh peak_rss_mb and peak_vram_mib), tokens/s (speed.md)",
      "blind comparison against the ChatGPT storyboard",
    ],
  };
};
export type DirectorSummary = ReturnType<typeof summarizeDirectorRuns>;

/** The automatic half of spec 5.7.5; the human half stays in the manual list. */
export const automaticEntryGate = (
  split: "tuning" | "holdout",
  fixtures: readonly SceneDirectorFixture[],
  summary: DirectorSummary,
) => ({
  heldOutSet: split === "holdout",
  productionScripts: fixtures.every((fixture) => fixture.source.startsWith("production:")),
  everyFixturePassed: summary.finalOkRate === 1,
  noCopyChanges: summary.copyChanges === 0,
  noUnknownActionOrAsset: summary.unsupportedActions === 0 && summary.invalidAssetReferences === 0,
  noExpectationMisses: summary.expectationMisses.length === 0,
});

/** Reads `<fixturesDir>/<split>/fixtures.json`: the synthetic sets or an exported production set. */
export const readFixtureFile = async (
  fixturesDir: string,
  split: "tuning" | "holdout",
): Promise<SceneDirectorFixtureFile> =>
  JSON.parse(
    await readFile(join(fixturesDir, split, "fixtures.json"), "utf8"),
  ) as SceneDirectorFixtureFile;

const USAGE = "usage: director-bench.js tuning|holdout [fixturesDir] [outDir]";

const main = async (): Promise<void> => {
  const [
    split,
    fixturesDir = "packages/core/src/explainer/fixtures/scene-director",
    outDir = "director-bench-out",
  ] = process.argv.slice(2);
  if (split !== "tuning" && split !== "holdout") throw new Error(USAGE);
  const candidates = readDirectorBenchCandidates(process.env);
  const file = await readFixtureFile(fixturesDir, split);
  await mkdir(outDir, { recursive: true });
  for (const candidate of candidates) {
    // The env names what was asked for; only llama-server's own answer says what is loaded.
    const provenance = await identifyLlamaServerModel(candidate);
    console.log(JSON.stringify({ provenance }));
    const director = createLlamaServerSceneDirector(candidate);
    const runs: DirectorRun[] = [];
    for (const fixture of file.fixtures) {
      const started = performance.now();
      const result = await directScenes(director, fixtureInput(file, fixture));
      const latencyMs = Math.round(performance.now() - started);
      runs.push({ fixture, result, latencyMs });
      console.log(JSON.stringify(directorCaseResult(candidate, runs.at(-1)!)));
    }
    const summary = summarizeDirectorRuns(runs);
    const gate = {
      ...automaticEntryGate(split, file.fixtures, summary),
      modelVerified: provenance.modelVerified,
    };
    const name = `${split}-${candidate.model.replace(/[^\w.-]/g, "_")}.json`;
    await writeFile(
      join(outDir, name),
      JSON.stringify(
        {
          model: candidate.model,
          candidate,
          provenance,
          split,
          summary,
          gate,
          runs,
          cases: runs.map((run) => directorCaseResult(candidate, run)),
        },
        null,
        1,
      ),
    );
    console.log(JSON.stringify({ candidate, provenance, summary, gate }, null, 1));
  }
};

if (process.argv[1]?.endsWith("director-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "director bench failed");
    process.exitCode = 1;
  });
}
