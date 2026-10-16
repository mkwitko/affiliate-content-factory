import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseFrameReview,
  type VlmFrame,
  type VlmIssueKind,
} from "@money-maker/core/explainer/visual-qa/vlm-review";
import {
  createLlamaServerFrameReviewer,
  readFrameReviewerConfig,
} from "@money-maker/providers/llm/llama-server-frame-reviewer";

/**
 * B5 (v2 spec appendix B): runs golden frames through a local llama-server started with --mmproj.
 * labels.json maps a PNG name to the issue kinds a human expects ([] for a clean frame). Each
 * frame is reviewed twice so agreement (same kinds both times) is measurable. Never queued.
 */
export type VlmBenchRun = Readonly<{
  file: string;
  expected: readonly VlmIssueKind[];
  latenciesMs: readonly [number, number];
  /** Issue kinds per run; null when the reply was not the schema. */
  kinds: readonly [readonly VlmIssueKind[] | null, readonly VlmIssueKind[] | null];
}>;

const rate = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

export const summarizeVlmBench = (runs: readonly VlmBenchRun[]) => {
  const bad = runs.filter((run) => run.expected.length > 0);
  const clean = runs.filter((run) => run.expected.length === 0);
  const first = (run: VlmBenchRun) => run.kinds[0];
  const caught = bad.filter((run) =>
    run.expected.some((kind) => first(run)?.includes(kind)),
  ).length;
  const falsePositives = clean.filter((run) => (first(run)?.length ?? 0) > 0).length;
  const latencies = runs.flatMap((run) => run.latenciesMs).sort((a, b) => a - b);
  const same = (run: VlmBenchRun) => {
    const [a, b] = run.kinds;
    return a !== null && b !== null && [...a].sort().join() === [...b].sort().join();
  };
  return {
    frames: runs.length,
    invalidReplies: runs.flatMap((run) => run.kinds).filter((kinds) => kinds === null).length,
    // A known-bad frame counts as caught when the reviewer names at least one expected kind.
    recall: rate(caught, bad.length),
    precision: rate(caught, caught + falsePositives),
    // A clean frame is falsely rejected when the reviewer reports any issue.
    falseReject: rate(falsePositives, clean.length),
    agreement: rate(runs.filter(same).length, runs.length),
    latencyMs: {
      median: latencies[Math.floor((latencies.length - 1) / 2)] ?? null,
      max: latencies.at(-1) ?? null,
    },
    manual: ["peak VRAM and RAM", "mmproj offload on versus off", "blind check of the notes"],
  };
};

const USAGE = "usage: vlm-bench.js <framesDir> [outDir]  (framesDir holds *.png and labels.json)";

const main = async (): Promise<void> => {
  const [dir, outDir = "vlm-bench-out"] = process.argv.slice(2);
  if (!dir) throw new Error(USAGE);
  const config = readFrameReviewerConfig(process.env);
  if (!config) throw new Error("FRAME_REVIEWER_URL is not set; the frame reviewer is disabled");
  const reviewer = createLlamaServerFrameReviewer(config);
  const labels = JSON.parse(await readFile(join(dir, "labels.json"), "utf8")) as Record<
    string,
    readonly VlmIssueKind[]
  >;
  const runs: VlmBenchRun[] = [];
  for (const [file, expected] of Object.entries(labels)) {
    const frame: VlmFrame = {
      sceneIndex: 1,
      hook: false,
      png: new Uint8Array(await readFile(join(dir, file))),
    };
    const measured: { ms: number; kinds: readonly VlmIssueKind[] | null }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const started = performance.now();
      const issues = parseFrameReview(await reviewer.review(frame).catch(() => null));
      measured.push({
        ms: Math.round(performance.now() - started),
        kinds: issues ? issues.map((issue) => issue.kind) : null,
      });
    }
    const [a, b] = measured;
    if (!a || !b) continue;
    runs.push({ file, expected, latenciesMs: [a.ms, b.ms], kinds: [a.kinds, b.kinds] });
    console.log(JSON.stringify({ file, expected, kinds: [a.kinds, b.kinds], ms: [a.ms, b.ms] }));
  }
  const summary = summarizeVlmBench(runs);
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, `b5-${config.model.replace(/[^\w.-]/g, "_")}.json`),
    JSON.stringify({ model: config.model, summary, runs }, null, 1),
  );
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("vlm-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "vlm bench failed");
    process.exitCode = 1;
  });
}
