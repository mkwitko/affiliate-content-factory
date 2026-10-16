import { readFile, writeFile } from "node:fs/promises";

/**
 * Creates the human review sheet for a director benchmark JSON (spec 5.7.5, human half). It reads
 * the benchmark and writes a separate file; the automatic results are never touched. Scores are
 * 1 (unusable) to 5 (publishable as is); `product_visibility` also takes "n/a" when the piece
 * shows no product. `editorial_decision` is pass | needs_fix | fail.
 */
export const REVIEW_SCALE = {
  scores:
    "1 = unusable, 2 = major problems, 3 = usable with fixes, 4 = minor nits, 5 = publishable",
  product_visibility: "1-5, or n/a when the piece shows no product",
  editorial_decision: "pass | needs_fix | fail",
  manual_fix_minutes: "minutes a human spent fixing the storyboard (0 when none)",
} as const;

type BenchCase = Readonly<{
  case_id: string;
  accepted: boolean;
  retry_count: number;
  validation_failures: readonly string[];
}>;
type Bench = Readonly<{
  model: string;
  split: string;
  cases: readonly BenchCase[];
  runs: readonly Readonly<{ fixture: Readonly<{ id: string; source: string }> }>[];
}>;

export const reviewSheetFor = (bench: Bench, benchmarkPath: string, createdAt: Date) => ({
  benchmark: benchmarkPath,
  model: bench.model,
  split: bench.split,
  createdAt: createdAt.toISOString(),
  scale: REVIEW_SCALE,
  cases: bench.cases.map((item) => ({
    case_id: item.case_id,
    source: bench.runs.find((run) => run.fixture.id === item.case_id)?.fixture.source ?? null,
    accepted: item.accepted,
    retry_count: item.retry_count,
    validation_failures: [...item.validation_failures],
    story_coherence: null,
    scene_continuity: null,
    visual_specificity: null,
    product_visibility: null,
    character_consistency: null,
    commercial_intent: null,
    editorial_decision: null,
    manual_fix_minutes: null,
    notes: "",
  })),
});

const USAGE = "usage: director-review-init.js <benchmark.json> [review.json]";

const main = async (): Promise<void> => {
  const [benchmarkPath, outArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  if (!benchmarkPath?.endsWith(".json")) throw new Error(USAGE);
  const out = outArg ?? benchmarkPath.replace(/\.json$/, ".review.json");
  const bench = JSON.parse(await readFile(benchmarkPath, "utf8")) as Bench;
  if (!Array.isArray(bench.cases) || !Array.isArray(bench.runs))
    throw new Error(`${benchmarkPath} is not a director-bench result`);
  // "wx": never overwrite a sheet someone may already have filled in.
  await writeFile(
    out,
    `${JSON.stringify(reviewSheetFor(bench, benchmarkPath, new Date()), null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  console.log(JSON.stringify({ review: out, cases: bench.cases.length }));
};

if (process.argv[1]?.endsWith("director-review-init.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "director review init failed");
    process.exitCode = 1;
  });
}
