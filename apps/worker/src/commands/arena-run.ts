import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ARENA_CATALOG,
  ARENA_TASKS,
  type ArenaCandidate,
  type ArenaTarget,
  type ArenaTask,
  candidatesFor,
  championFor,
  profileIdOf,
} from "@money-maker/core/arena/catalog";
import {
  buildLeaderboard,
  type CandidateResult,
  renderLeaderboardMarkdown,
} from "@money-maker/core/arena/leaderboard";
import { ARENA_STAGES, type ArenaStage } from "@money-maker/core/arena/promotion";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import {
  type ArenaEnv,
  classifyRuntimeFailure,
  downloadFile,
  freeBytes,
  missingBytes,
  removeFiles,
} from "../arena/runtime.js";
import type { Suite } from "../arena/suite.js";
import { ARENA_SUITES } from "../arena/suites/index.js";
import { type ArenaRunSpec, buildJudgePage } from "./arena.js";

/**
 * `pnpm ai:arena run <task>`: download, start, test and stop every catalog candidate of a task
 * one at a time, then judge, rank and write a blind page for the owner's final call.
 *
 *   --stage=smoke|qualification|full (default smoke)   --only=<id,id>   --target=cpu|desktop_amd
 *   --out=<dir>   --rerun (ignore the checkpoint)   --dry-run (plan only, no download)
 *   --report-only (leaderboard and owner page from the checkpoint)
 *   --dataset=real (level 2: the real Mercado Livre products instead of the fixed fixtures)
 *
 * Checkpoint: <out>/results.json; a rerun skips candidates already measured at this stage.
 * Nothing here changes model policy: the leaderboard's proposals are advice.
 */
const execFileAsync = promisify(execFile);
/** Keep this much disk free after a download (models, outputs, OS). */
const DISK_HEADROOM = 3e9;

type State = {
  task: ArenaTask;
  stage: ArenaStage;
  dirs: Record<string, string>;
  results: CandidateResult[];
};

const flag = (args: readonly string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const blocked = (
  candidate: ArenaCandidate,
  status: CandidateResult["status"],
  stage: ArenaStage,
  error: string,
): CandidateResult => ({
  id: candidate.id,
  status,
  error,
  stage,
  cases: [],
  aggregate: {},
  latencyP95Ms: null,
  failureRate: 1,
  peakVramMb: null,
});

/** Candidates in run order: champion first (it records shared references), optional ones only when named. */
export const planCandidates = (
  task: ArenaTask,
  target: ArenaTarget,
  only: readonly string[] | null,
): readonly ArenaCandidate[] =>
  candidatesFor(task)
    .filter((c) => (only ? only.includes(c.id) : !c.optional))
    .filter((c) => c.targets.includes(target))
    .sort((a, b) => Number(Boolean(b.champion)) - Number(Boolean(a.champion)));

/** Arena status for a thrown run: missing inputs are NOT_TESTED, never a model verdict. */
export const classifyFailure = (message: string, cause: string): CandidateResult["status"] => {
  if (/^download|^fetch failed|ENOENT|needs_desktop|_missing/.test(message)) return "NOT_TESTED";
  if (message === "runtime_start_failed") return classifyRuntimeFailure(cause);
  if (message.startsWith("runtime_port_busy")) return "RUNTIME_BLOCKED";
  return /out of memory|OutOfDeviceMemory/i.test(`${message} ${cause}`) ? "OOM" : "FAILED";
};

/** Saves the server logs and returns their text, so an out-of-memory failure is called OOM. */
const saveDesktopLogs = async (dir: string): Promise<string> => {
  await mkdir(dir, { recursive: true });
  let all = "";
  for (const name of ["sd-server", "llama-server"])
    for (const stream of ["out", "err"]) {
      const text = await readFile(`/mnt/e/ai/logs/${name}.${stream}.log`, "utf8").catch(() => "");
      if (!text) continue;
      // The head says which weights and settings were loaded; the tail says how it ended.
      const lines = text.split("\n");
      const kept =
        lines.length > 180 ? [...lines.slice(0, 60), "...", ...lines.slice(-120)] : lines;
      await writeFile(join(dir, `${name}.${stream}.log`), kept.join("\n"));
      all += text;
    }
  return all;
};

export const licenceRefusal = (candidate: ArenaCandidate): string | null => {
  const policy = modelPolicyFor(profileIdOf(candidate.id));
  if (!policy) return "model_not_registered";
  if (policy.licensePolicy === "research_only" || policy.licensePolicy === "blocked")
    return `licence_${policy.licensePolicy}`;
  return null;
};

export const detectTarget = async (): Promise<ArenaTarget> =>
  (await execFileAsync("sh", ["-c", "command -v powershell.exe"]).then(
    () => true,
    () => false,
  ))
    ? "desktop_amd"
    : "cpu";

export const environment = (
  target: ArenaTarget,
  repoRoot: string,
  dataset: ArenaEnv["dataset"],
): ArenaEnv => {
  const home =
    process.env.ARENA_HOME ??
    (target === "desktop_amd" ? "/mnt/e/ai" : join(homedir(), "ai-arena"));
  return {
    target,
    modelsDir: join(home, "models"),
    runtimeModelsDir: target === "desktop_amd" ? "E:\\ai\\models" : join(home, "models"),
    binDir: join(home, target === "desktop_amd" ? "arena-bin" : "bin"),
    repoRoot,
    dataset,
    log: (line) => console.log(line),
  };
};

const save = (out: string, state: State) =>
  writeFile(join(out, "results.json"), JSON.stringify(state, null, 1));

/** Blind A/B page over the candidates' output files (image, audio or video suites). */
/** Challengers on the owner's page: the best ones by the quantitative ranking. */
const HUMAN_PAGE_CHALLENGERS = 3;

const writeHumanPage = async (
  suite: Suite,
  state: State,
  out: string,
  championId: string | null,
  ranked: readonly string[],
) => {
  if (suite.media.kind === "text") return null;
  const top = new Set([
    ...(championId ? [championId] : []),
    ...ranked.filter((id) => id !== championId).slice(0, HUMAN_PAGE_CHALLENGERS),
  ]);
  const ok = state.results.filter((r) => r.status === "ok" && top.has(r.id));
  const champion = ok.find((r) => r.id === championId) ?? ok[0];
  if (!champion || ok.length < 2) return null;
  const spec: ArenaRunSpec = {
    task: state.task,
    champion: champion.id,
    media: { kind: suite.media.kind, ext: suite.media.ext },
    candidates: ok.map((r) => ({ id: r.id, dir: state.dirs[r.id] as string })),
    cases: champion.cases.map((c) => ({
      caseId: c.caseId,
      brief: suite.brief?.(c.caseId) ?? c.caseId,
    })),
  };
  await writeFile(join(out, "arena.json"), JSON.stringify(spec, null, 1));
  const available = new Set<string>();
  for (const c of spec.candidates)
    for (const f of await readdir(join(out, c.dir)).catch(() => [] as string[]))
      available.add(`${c.dir}/${f}`);
  const page = join(out, "judge.html");
  await writeFile(page, buildJudgePage(spec, available, Date.now() % 1e9));
  return page;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const task = args.find((a) => !a.startsWith("--")) as ArenaTask | undefined;
  if (!task || !(ARENA_TASKS as readonly string[]).includes(task))
    throw new Error(
      `usage: arena-run.js <${ARENA_TASKS.join("|")}> [--stage=] [--only=] [--target=]`,
    );
  const suite = ARENA_SUITES[task];
  if (!suite) throw new Error(`arena_suite_missing:${task}`);
  const stage = (flag(args, "stage") ?? "smoke") as ArenaStage;
  if (!(stage in ARENA_STAGES)) throw new Error("arena_stage_invalid");
  const target = (flag(args, "target") as ArenaTarget | undefined) ?? (await detectTarget());
  const only = flag(args, "only")?.split(",").filter(Boolean) ?? null;
  const repoRoot = resolve(process.cwd());
  const dataset = flag(args, "dataset") === "real" ? "real" : "corpus";
  const env = environment(target, repoRoot, dataset);
  const out =
    flag(args, "out") ??
    join(
      repoRoot,
      "reports/ai-arena",
      new Date().toISOString().slice(0, 10),
      `${task}-${stage}${dataset === "real" ? "-real" : ""}`,
    );
  await mkdir(out, { recursive: true });
  const candidates = planCandidates(task, target, only);
  const state: State = await readFile(join(out, "results.json"), "utf8")
    .then((text) => JSON.parse(text) as State)
    .catch(() => ({ task, stage, dirs: {}, results: [] }));
  if (args.includes("--rerun")) state.results = [];
  // Naming candidates re-measures them even when the checkpoint already holds a result.
  if (only) state.results = state.results.filter((r) => !only.includes(r.id));
  const plannedGb = (
    (await Promise.all(candidates.map((c) => missingBytes(c, env.modelsDir)))).reduce(
      (s, b) => s + b,
      0,
    ) / 1e9
  ).toFixed(1);
  env.log(
    `arena ${task} stage=${stage} target=${target} out=${out}\n  candidates: ${candidates.map((c) => c.id).join(", ")}\n  to download: ${plannedGb} GB, free: ${((await freeBytes(env.modelsDir)) / 1e9).toFixed(1)} GB`,
  );
  if (args.includes("--dry-run")) return;

  // --report-only rebuilds the leaderboard and the owner's page from the checkpoint.
  const reportOnly = args.includes("--report-only");
  for (const [index, candidate] of reportOnly ? [] : candidates.entries()) {
    state.dirs[candidate.id] ??= `c${String(Object.keys(state.dirs).length + 1).padStart(2, "0")}`;
    if (state.results.some((r) => r.id === candidate.id)) {
      env.log(`- ${candidate.id}: already measured (checkpoint)`);
      continue;
    }
    env.log(`- ${candidate.id} (${index + 1}/${candidates.length})`);
    const started = Date.now();
    let result: CandidateResult;
    const refusal = licenceRefusal(candidate);
    const need = await missingBytes(candidate, env.modelsDir);
    if (refusal) result = blocked(candidate, "LICENSE_BLOCKED", stage, refusal);
    else if (need > 0 && need > (await freeBytes(env.modelsDir)) - DISK_HEADROOM)
      result = blocked(
        candidate,
        "NOT_TESTED",
        stage,
        `disk_full_needs_${(need / 1e9).toFixed(1)}GB`,
      );
    else {
      try {
        for (const file of candidate.files) {
          const status = await downloadFile(file.url, join(env.modelsDir, file.file));
          if (status === "downloaded") env.log(`  downloaded ${file.file}`);
        }
        result = await suite.run({
          env,
          stage,
          outDir: out,
          dir: state.dirs[candidate.id] as string,
          candidate,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "arena_failed";
        const cause = String((error as { cause?: unknown }).cause ?? "");
        env.log(`  ${message}${cause ? `\n${cause.slice(-1_500)}` : ""}`);
        result = blocked(candidate, classifyFailure(message, cause), stage, message.slice(0, 120));
      }
    }
    if (result.status === "ok" && result.cases.length > 0 && result.failureRate === 1)
      result = {
        ...result,
        status: "FAILED",
        error: (result.caseErrors?.[0] ?? "all_cases_failed").slice(0, 160),
      };
    // On the desktop the server's own log says why a model failed or drew garbage: keep its tail.
    if (target === "desktop_amd") {
      const logs = await saveDesktopLogs(join(out, state.dirs[candidate.id] as string));
      if (result.status === "FAILED" && /OutOfDeviceMemory|out of memory/i.test(logs))
        result = { ...result, status: "OOM" };
    }
    state.results.push(result);
    await save(out, state);
    // Disk is the dev box's limit (cpu target only): a measured challenger's weights go, champions (also the
    // judges and dataset makers) and files a later candidate needs stay. --keep-models keeps all.
    if (target === "cpu" && !args.includes("--keep-models") && !candidate.champion) {
      const keep = new Set(
        [...ARENA_CATALOG.filter((c) => c.champion), ...candidates.slice(index + 1)].flatMap((c) =>
          c.files.map((f) => f.file),
        ),
      );
      await removeFiles(candidate, env, keep);
    }
    env.log(
      `  ${result.status}${result.error ? ` (${result.error})` : ""} in ${Math.round((Date.now() - started) / 1000)} s`,
    );
  }

  if (suite.judge && !reportOnly) {
    env.log("judging");
    state.results = [
      ...(await suite.judge(state.results, {
        env,
        stage,
        outDir: out,
        dirs: new Map(Object.entries(state.dirs)),
      })),
    ];
    await save(out, state);
  }
  const champion = championFor(task)?.id ?? null;
  const board = buildLeaderboard(task, state.results, champion);
  const markdown = renderLeaderboardMarkdown(board);
  await writeFile(join(out, "leaderboard.md"), markdown);
  await writeFile(join(out, "leaderboard.json"), JSON.stringify(board, null, 1));
  const page = await writeHumanPage(
    suite,
    state,
    out,
    champion,
    board.rows.filter((r) => r.rank !== null && r.gatesFailed.length === 0).map((r) => r.id),
  );
  console.log(markdown);
  if (page)
    env.log(
      `Human check: open ${page}, pick the better of each pair, save judgments-human.json next to it, then run: node apps/worker/dist/commands/arena.js report ${out}`,
    );
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "arena run failed");
    process.exitCode = 1;
  });
}
