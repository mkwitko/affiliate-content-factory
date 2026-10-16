import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EDIT_BENCH_CORPUS,
  EDIT_BENCH_PRODUCT_TITLES,
  type EditBenchCase,
} from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import {
  type ColourEvidence,
  type InSceneVerdict,
  judgeInSceneFidelity,
  parseVlmFidelityAnswer,
  productVisualSpecFor,
  type SubjectBox,
} from "@money-maker/core/creatives/in-scene-fidelity";
import { fitImage } from "@money-maker/providers/http/fit-image";
import {
  createLlamaServerFidelityVlm,
  type FidelityVlmImage,
} from "@money-maker/providers/llm/llama-server-fidelity-vlm";
import { colourEvidence } from "@money-maker/providers/media/sharp-colour-evidence";

/**
 * Product fidelity bench: can a local VLM plus the deterministic colour check tell the right
 * product from a swapped one? Positives pair each edit-bench scene with its own product,
 * negatives with the other products. Evidence for a human decision: `promoted` is always false.
 */
export type FidelityPair = Readonly<{
  pairId: string;
  kind: "positive" | "negative" | "subjects";
  caseId: string;
  productAssetId: string;
  title: string;
}>;

export type FidelityRow = Readonly<{
  pairId: string;
  kind: "positive" | "negative" | "subjects";
  caseId: string;
  productAssetId: string;
  verdict: InSceneVerdict;
  reasons: readonly string[];
  parsed: boolean;
  /** VLM subject boxes (0..1000, Qwen3-VL convention); null when absent or invalid. */
  subjects: readonly SubjectBox[] | null;
  latencyMs: number | null;
  error: string | null;
}>;

/**
 * Sidecars for the desktop preview flow: the boxes from each scene's positive pair (its own
 * product), written next to the scene as `<caseId>.subjects.json` for `post-preview`.
 */
export const subjectSidecars = (rows: readonly FidelityRow[]) =>
  rows.flatMap((row) =>
    (row.kind === "positive" || row.kind === "subjects") && row.subjects
      ? [{ caseId: row.caseId, subjects: row.subjects }]
      : [],
  );

/** Problem scenes may hide the product, so only the original feed/story cases are paired. */
export const FIDELITY_CASES: readonly EditBenchCase[] = EDIT_BENCH_CORPUS.filter((item) =>
  /_(feed|story)$/.test(item.id),
);

/** Reel scenes: one own-product call each, only for the subject boxes (no negatives, no metrics). */
export const buildSubjectPairs = (
  cases: readonly EditBenchCase[],
  titles: Readonly<Record<string, string>> = EDIT_BENCH_PRODUCT_TITLES,
): readonly FidelityPair[] =>
  cases.map((item) => {
    const productAssetId = item.references[1];
    const title = titles[productAssetId];
    if (!title) throw new Error("fidelity_bench_title_missing");
    return {
      pairId: `${item.id}:${productAssetId.slice(0, 8)}`,
      kind: "subjects",
      caseId: item.id,
      productAssetId,
      title,
    };
  });

export const buildPairs = (
  cases: readonly EditBenchCase[],
  titles: Readonly<Record<string, string>> = EDIT_BENCH_PRODUCT_TITLES,
): readonly FidelityPair[] => {
  const products = [...new Set(cases.map((item) => item.references[1]))];
  return cases.flatMap((item) =>
    products.map((productAssetId): FidelityPair => {
      const title = titles[productAssetId];
      if (!title) throw new Error("fidelity_bench_title_missing");
      const kind = productAssetId === item.references[1] ? "positive" : "negative";
      return {
        pairId: `${item.id}:${productAssetId.slice(0, 8)}`,
        kind,
        caseId: item.id,
        productAssetId,
        title,
      };
    }),
  );
};

export type FidelityBenchDeps = Readonly<{
  pairs: readonly FidelityPair[];
  loadScene: (caseId: string) => Promise<FidelityVlmImage>;
  loadReference: (assetId: string) => Promise<FidelityVlmImage>;
  compare: (input: {
    reference: FidelityVlmImage;
    scene: FidelityVlmImage;
    spec: ReturnType<typeof productVisualSpecFor>;
  }) => Promise<unknown>;
  colour: (reference: Uint8Array, scene: Uint8Array) => Promise<ColourEvidence>;
  onRow?: (row: FidelityRow) => void;
}>;

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
    ? error.message
    : "bench_failed";

export const runFidelityBench = async (
  deps: FidelityBenchDeps,
): Promise<readonly FidelityRow[]> => {
  const rows: FidelityRow[] = [];
  for (const pair of deps.pairs) {
    const base = {
      pairId: pair.pairId,
      kind: pair.kind,
      caseId: pair.caseId,
      productAssetId: pair.productAssetId,
    };
    let row: FidelityRow;
    try {
      const [scene, reference] = await Promise.all([
        deps.loadScene(pair.caseId),
        deps.loadReference(pair.productAssetId),
      ]);
      const spec = productVisualSpecFor(pair.title);
      const started = performance.now();
      const answer = await deps.compare({ reference, scene, spec });
      const latencyMs = Math.round(performance.now() - started);
      const vlm = parseVlmFidelityAnswer(answer, spec) ?? undefined;
      const colour = await deps.colour(reference.bytes, scene.bytes);
      const judged = judgeInSceneFidelity({ spec, vlm, colour });
      row = {
        ...base,
        ...judged,
        parsed: vlm !== undefined,
        subjects: vlm?.subjects ?? null,
        latencyMs,
        error: null,
      };
    } catch (error) {
      row = {
        ...base,
        verdict: "review",
        reasons: [],
        parsed: false,
        subjects: null,
        latencyMs: null,
        error: errorCode(error),
      };
    }
    rows.push(row);
    deps.onRow?.(row);
  }
  return rows;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export const summarizeFidelityBench = (allRows: readonly FidelityRow[]) => {
  const rows = allRows.filter((row) => row.kind !== "subjects");
  const positives = rows.filter((row) => row.kind === "positive");
  const negatives = rows.filter((row) => row.kind === "negative");
  const accepted = positives.filter((row) => row.verdict === "pass").length;
  const blocked = negatives.filter((row) => row.verdict === "block").length;
  const falseAccepts = negatives.filter((row) => row.verdict === "pass").length;
  const times = rows
    .flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]))
    .sort((a, b) => a - b);
  return {
    promoted: false as const,
    positives: {
      total: positives.length,
      accepted,
      trueAcceptRate: positives.length ? accepted / positives.length : null,
    },
    negatives: {
      total: negatives.length,
      blocked,
      falseAccepts,
      falseAcceptRate: negatives.length ? falseAccepts / negatives.length : null,
    },
    parseFailures: rows.filter((row) => !row.parsed).length,
    p50LatencyMs: percentile(times, 0.5),
    p95LatencyMs: percentile(times, 0.95),
    gate: {
      positivesAcceptedMin: 5,
      negativesBlockedRequired: 12,
      met: positives.length === 6 && accepted >= 5 && negatives.length === 12 && blocked === 12,
    },
  };
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const main = async (): Promise<void> => {
  const baseUrl = process.env.FIDELITY_BENCH_URL;
  if (!baseUrl) throw new Error("fidelity_bench_url_required");
  const model = process.env.FIDELITY_BENCH_MODEL ?? "local:qwen3-vl-4b";
  const input = flag(process.argv.slice(2), "in") ?? "edit-bench-out";
  const vlm = createLlamaServerFidelityVlm({ baseUrl, model });
  const read = async (file: string): Promise<FidelityVlmImage> => {
    const bytes = new Uint8Array(await readFile(file));
    return { bytes, mimeType: (await fitImage(bytes)).mimeType };
  };
  const outDir = join(input, "fidelity");
  await mkdir(outDir, { recursive: true });
  const lines: string[] = [];
  const reelCases = EDIT_BENCH_CORPUS.filter(
    (item) =>
      /_(problem2?|discovery|result)$/.test(item.id) &&
      existsSync(join(input, "images", `${item.id}.png`)),
  );
  const rows = await runFidelityBench({
    pairs: [...buildPairs(FIDELITY_CASES), ...buildSubjectPairs(reelCases)],
    loadScene: (caseId) => read(join(input, "images", `${caseId}.png`)),
    loadReference: (assetId) => read(join(input, "refs", `${assetId}.bin`)),
    compare: (args) => vlm.compare(args),
    colour: colourEvidence,
    onRow: (row) => {
      lines.push(JSON.stringify(row));
      console.log(lines.at(-1));
    },
  });
  await writeFile(join(outDir, "rows.jsonl"), `${lines.join("\n")}\n`);
  for (const sidecar of subjectSidecars(rows))
    await writeFile(
      join(input, "images", `${sidecar.caseId}.subjects.json`),
      JSON.stringify(sidecar.subjects),
    );
  const summary = summarizeFidelityBench(rows);
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("fidelity-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "fidelity bench failed");
    process.exitCode = 1;
  });
}
