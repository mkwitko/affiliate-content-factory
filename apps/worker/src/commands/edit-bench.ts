import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  EDIT_BENCH_CORPUS,
  type EditBenchCase,
} from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import type { ImageEditor } from "@money-maker/core/creatives/scene-bank";
import { reencodeImage } from "@money-maker/providers/http/fit-image";
import { createSdCppImageEditor } from "@money-maker/providers/media/sdcpp-scene-generator";

/**
 * Quality spike: put the real product photo plus a recurring character into a scene with a local
 * reference-edit model. Results are evidence for a human decision: `promoted` is always false.
 * Images stay in the out dir (git-ignored). Human score and product fidelity are filled in by hand.
 */
export type EditRow = Readonly<{
  caseId: string | null;
  model: string;
  steps: number;
  width: number | null;
  height: number | null;
  wallMs: number | null;
  outputBytes: number | null;
  decodeValid: boolean;
  dimensionsValid: boolean;
  humanScore: null;
  productFidelity: null;
  error: string | null;
  /** The runtime's failure message, when it gave one. */
  detail?: string;
}>;

// Same owner gate as the plate bench: 10 minutes per image on the desktop GPU.
const MAX_SEC = 600;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_REF_BYTES = 10_000_000;

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "edit_failed";

export type EditBenchOptions = Readonly<{
  model: string;
  steps: number;
  cases: readonly EditBenchCase[];
  loadReference: (assetId: string) => Promise<Uint8Array>;
  editor: ImageEditor;
  onImage?: (name: string, bytes: Uint8Array) => Promise<void>;
  onRow?: (row: EditRow) => void;
}>;

export const runEditBench = async (options: EditBenchOptions): Promise<readonly EditRow[]> => {
  const rows: EditRow[] = [];
  const push = (r: EditRow) => {
    rows.push(r);
    options.onRow?.(r);
  };
  const base = {
    model: options.model,
    steps: options.steps,
    humanScore: null,
    productFidelity: null,
  };
  let failures = 0;
  for (const item of options.cases) {
    if (failures >= MAX_CONSECUTIVE_FAILURES) break;
    const size = { width: item.width, height: item.height };
    const started = performance.now();
    try {
      const references = await Promise.all(item.references.map(options.loadReference));
      const image = await options.editor.edit(item.prompt, references, size);
      const wallMs = Math.round(performance.now() - started);
      failures = 0;
      const decoded = await reencodeImage(image.bytes).catch(() => null);
      push({
        ...base,
        caseId: item.id,
        ...size,
        wallMs,
        outputBytes: image.bytes.byteLength,
        decodeValid: decoded !== null,
        dimensionsValid:
          decoded !== null && decoded.width === item.width && decoded.height === item.height,
        error: null,
      });
      if (decoded) await options.onImage?.(`${item.id}.png`, image.bytes).catch(() => undefined);
    } catch (error) {
      failures += 1;
      push({
        ...base,
        caseId: item.id,
        ...size,
        wallMs: Math.round(performance.now() - started),
        outputBytes: null,
        decodeValid: false,
        dimensionsValid: false,
        error: errorCode(error),
        ...(error instanceof Error && typeof error.cause === "string"
          ? { detail: error.cause }
          : {}),
      });
    }
  }
  return rows;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export const summarizeEditBench = (rows: readonly EditRow[]) => {
  const generated = rows.filter((r) => r.error === null && r.wallMs !== null);
  const times = generated.map((r) => r.wallMs as number).sort((a, b) => a - b);
  const failures = rows.filter((r) => r.error !== null).length;
  return {
    promoted: false as const,
    rows: rows.length,
    failures,
    p50WallMs: percentile(times, 0.5),
    p95WallMs: percentile(times, 0.95),
    gate: {
      maxSec: MAX_SEC,
      noCrash: failures === 0,
      allDecoded: generated.length > 0 && generated.every((r) => r.decodeValid),
      humanReviewPending: true,
    },
  };
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Downloads a public reference once (redirects followed, size capped, must decode) and caches it. */
export const loadReference = async (
  base: string,
  assetId: string,
  cacheDir: string,
  doFetch: Fetch = fetch,
): Promise<Uint8Array> => {
  if (!/^[0-9a-f-]{36}$/.test(assetId)) throw new Error("edit_bench_reference_invalid");
  const file = join(cacheDir, `${assetId}.bin`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return new Uint8Array(cached);
  const response = await doFetch(`${base}${assetId}`, { redirect: "follow" });
  if (!response.ok) throw new Error("edit_bench_reference_download_failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REF_BYTES)
    throw new Error("edit_bench_reference_invalid");
  if (!(await reencodeImage(bytes).catch(() => null)))
    throw new Error("edit_bench_reference_invalid");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, bytes);
  return bytes;
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

export const selectCases = (ids: string | undefined): readonly EditBenchCase[] => {
  if (!ids) return EDIT_BENCH_CORPUS;
  const wanted = ids.split(",").map((s) => s.trim());
  const chosen = EDIT_BENCH_CORPUS.filter((c) => wanted.includes(c.id));
  if (chosen.length !== wanted.length) throw new Error("edit_bench_case_unknown");
  return chosen;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const baseUrl = process.env.EDIT_BENCH_URL;
  if (!baseUrl) throw new Error("edit_bench_url_required");
  const model = process.env.EDIT_BENCH_MODEL ?? "local:flux-2-klein-4b";
  const refBase =
    process.env.EDIT_BENCH_REF_BASE ??
    "https://mcp.example.com/v1/public/workspaces/WORKSPACE_ID/assets/";
  const steps = Number(flag(args, "steps") ?? 4);
  const timeoutSec = Number(flag(args, "timeout-sec") ?? 900);
  if (!Number.isInteger(steps) || steps < 1 || steps > 100)
    throw new Error("edit_bench_steps_invalid");
  if (!Number.isInteger(timeoutSec) || timeoutSec < 10 || timeoutSec > 3600)
    throw new Error("edit_bench_timeout_invalid");
  const out = flag(args, "out") ?? "edit-bench-out";
  // --scale=0.667 renders 768x960 / 768x1344 at 512x640 / 512x896 (64-aligned), for upscaling.
  const scale = Number(flag(args, "scale") ?? 1);
  if (!(scale >= 0.5 && scale <= 1)) throw new Error("edit_bench_scale_invalid");
  const align = (n: number) => Math.max(512, Math.round((n * scale) / 64) * 64);
  const cases = selectCases(flag(args, "cases")).map((c) =>
    scale === 1 ? c : { ...c, width: align(c.width), height: align(c.height) },
  );
  const referenceMaxSide = Number(flag(args, "ref-side") ?? 768);
  await mkdir(out, { recursive: true });
  const lines: string[] = [];
  // The adapter enforces the loopback/private URL rule and the licence policy; arena mode lets a
  // disabled challenger run here, never in production.
  const editor = createSdCppImageEditor({
    baseUrl,
    model,
    arena: true,
    steps,
    referenceMaxSide,
    timeoutMs: timeoutSec * 1000,
  });
  const rows = await runEditBench({
    model,
    steps,
    cases,
    editor,
    loadReference: (id) => loadReference(refBase, id, join(out, "refs")),
    onImage: async (name, bytes) => {
      await mkdir(join(out, "images"), { recursive: true });
      await writeFile(join(out, "images", name), bytes);
    },
    onRow: (r) => {
      lines.push(JSON.stringify(r));
      console.log(lines.at(-1));
    },
  });
  await writeFile(join(out, "rows.jsonl"), `${lines.join("\n")}\n`);
  const summary = summarizeEditBench(rows);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("edit-bench.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "edit bench failed");
    process.exitCode = 1;
  });
}
