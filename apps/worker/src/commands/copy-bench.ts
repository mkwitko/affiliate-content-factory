import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import {
  COPY_BENCH_CORPUS,
  type CopyBenchCase,
} from "@money-maker/core/content/fixtures/copy-bench-corpus";
import {
  draftOfferCopyWithCorrections,
  offerCopyHookCandidates,
} from "@money-maker/core/content/offer-copy";
import {
  type Copywriter,
  createLlamaServerCopywriter,
} from "@money-maker/providers/llm/llama-server-copywriter";

/**
 * Affiliate copy benchmark: evidence for an OWNER decision to promote a model for copywriting
 * (`copywriting: true` in model policy). Deterministic gates run here; whether the copy invents
 * a feature, claim or promise is read by a human in outputs.md. `promoted` is always false.
 */
export type CopyRow = Readonly<{
  caseId: string;
  niche: string;
  run: number;
  ok: boolean;
  code: string | null;
  latencyMs: number;
  /** Model calls for this row: 1 draft plus up to 2 corrections. */
  attempts: number;
  strippedHashtags: number;
  /** Rule-breaking parts the repair removed before validation, over all attempts. */
  repairs: number;
  /** Hook options the model offered (capped at 4) and how many passed the draft's gates. */
  hookOptions: number;
  validHookOptions: number;
  error: string | null;
}>;

export type CopyBenchResult = Readonly<{ rows: readonly CopyRow[]; outputs: string }>;

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

const renderDraft = (draft: unknown): string => {
  const d = draft as Partial<{
    slides: readonly Partial<{ headline: unknown; body: unknown }>[];
    captions: Record<string, unknown>;
  }>;
  const slides = Array.isArray(d?.slides)
    ? d.slides.map(
        (s, i) => `${i + 1}. ${asText(s?.headline)}${s?.body ? ` | ${asText(s.body)}` : ""}`,
      )
    : [asText(d?.slides)];
  const captions = Object.entries(d?.captions ?? {}).map(([k, v]) => `${k}: ${asText(v)}`);
  return [...slides, "", ...captions].join("\n");
};

const hookOptionsOf = (raw: unknown): readonly unknown[] => {
  const list = typeof raw === "object" && raw !== null ? Reflect.get(raw, "hookOptions") : null;
  return Array.isArray(list) ? list.slice(0, 4) : [];
};

export const runCopyBench = async (
  copywriter: Copywriter,
  options: Readonly<{ runs: number; cases?: readonly CopyBenchCase[] }>,
): Promise<CopyBenchResult> => {
  const rows: CopyRow[] = [];
  const blocks: string[] = [];
  for (const item of options.cases ?? COPY_BENCH_CORPUS) {
    for (let run = 1; run <= options.runs; run += 1) {
      const started = performance.now();
      const base = { caseId: item.id, niche: item.niche, run };
      let row: CopyRow;
      let text: string;
      try {
        // The production loop: repair, validate, and up to two corrections with feedback.
        const context = {
          facts: item.facts,
          sourceFactKeys: item.sourceFactKeys,
          // The deck size the packet asked for (beatsFor): a thin product gets fewer slides.
          slideCount: item.input.slideCount,
          channels: ["instagram_carousel", "threads"] as const,
          captionMaxLength: { threads: 500 },
        };
        const outcome = await draftOfferCopyWithCorrections(
          (correction) => copywriter.draft(item.input, correction),
          context,
        );
        const check = outcome.check;
        const offered = hookOptionsOf(outcome.raw);
        const valid = new Set(
          check?.ok
            ? offerCopyHookCandidates(check, outcome.raw, context)
                .slice(1)
                .map((c) => c.hook.headline)
            : [],
        );
        const hookLines = offered.map((option) => {
          const headline = asText(Reflect.get(Object(option), "headline"));
          const line = asText(Reflect.get(Object(option), "captionFirstLine"));
          return `hook ${valid.has(headline.trim()) ? "ok" : "dropped"}: ${headline} | ${line}`;
        });
        text = [renderDraft(outcome.raw), ...(hookLines.length ? ["", ...hookLines] : [])].join(
          "\n",
        );
        row = {
          ...base,
          ok: check?.ok === true,
          code: check ? (check.ok ? null : check.code) : "draft_shape",
          latencyMs: Math.round(performance.now() - started),
          attempts: outcome.attempts,
          strippedHashtags: check?.strippedHashtags ?? 0,
          repairs: outcome.repairs,
          hookOptions: offered.length,
          validHookOptions: valid.size,
          error: null,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown";
        text = "(no output)";
        row = {
          ...base,
          ok: false,
          code: null,
          latencyMs: Math.round(performance.now() - started),
          attempts: 0,
          strippedHashtags: 0,
          repairs: 0,
          hookOptions: 0,
          validHookOptions: 0,
          error: `runtime_error:${message}`,
        };
      }
      rows.push(row);
      const status = row.ok ? "ok" : (row.code ?? row.error);
      blocks.push(`## ${item.id} run ${run} (${status})\n\n${text}\n`);
    }
  }
  return { rows, outputs: `# Copy bench outputs\n\n${blocks.join("\n")}` };
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

const stats = (rows: readonly CopyRow[]) => {
  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    rows: rows.length,
    passed: rows.filter((r) => r.ok).length,
    passRate: rows.length === 0 ? 0 : rows.filter((r) => r.ok).length / rows.length,
    runtimeErrors: rows.filter((r) => r.error !== null).length,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
};

const PRODUCTION_READY_MIN = 0.9;

export const summarizeCopyBench = (rows: readonly CopyRow[], model: string) => {
  const codes: Record<string, number> = {};
  for (const r of rows) if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
  const total = stats(rows);
  // Each row already runs the production loop (repair + up to 2 corrections), so a case's pass
  // rate is the chance one production draft ends ok.
  const perCase = Object.fromEntries(
    [...new Set(rows.map((r) => r.caseId))].map((id) => {
      const caseRows = rows.filter((r) => r.caseId === id);
      return [id, { passRate: caseRows.filter((r) => r.ok).length / caseRows.length }];
    }),
  );
  const worst = Math.min(...Object.values(perCase).map((c) => c.passRate));
  return {
    model,
    total,
    perNiche: Object.fromEntries(
      [...new Set(rows.map((r) => r.niche))].map((n) => [
        n,
        stats(rows.filter((r) => r.niche === n)),
      ]),
    ),
    codes,
    perCase,
    hookOptions: {
      offered: rows.reduce((sum, r) => sum + r.hookOptions, 0),
      valid: rows.reduce((sum, r) => sum + r.validHookOptions, 0),
      rowsWithValidOption: rows.filter((r) => r.validHookOptions > 0).length,
    },
    gate: {
      schemaAndEvidencePass: rows.length > 0 && total.passed === rows.length,
      runtimeErrors: total.runtimeErrors,
      worstCasePassRate: rows.length ? worst : 0,
      productionReady:
        rows.length > 0 && total.runtimeErrors === 0 && worst >= PRODUCTION_READY_MIN,
    },
    promoted: false as const,
    humanReviewPending: true as const,
  };
};

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const runs = Number(flag(args, "runs") ?? 3);
  if (!Number.isInteger(runs) || runs < 1 || runs > 20) throw new Error("copy_bench_runs_invalid");
  const temperature = Number(flag(args, "temperature") ?? 0);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)
    throw new Error("copy_bench_temperature_invalid");
  const out = flag(args, "out") ?? "copy-bench-out";
  const baseUrl = process.env.COPY_BENCH_URL?.trim();
  const model = process.env.COPY_BENCH_MODEL?.trim();
  if (!baseUrl) throw new Error("copy_bench_url_required");
  if (!model || !modelPolicyFor(model)) throw new Error("copy_bench_model_unknown");
  const copywriter = createLlamaServerCopywriter({ baseUrl, model, temperature });
  const { rows, outputs } = await runCopyBench(copywriter, { runs });
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "rows.jsonl"), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  await writeFile(join(out, "outputs.md"), outputs);
  const summary = summarizeCopyBench(rows, model);
  await writeFile(join(out, "summary.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
};

if (process.argv[1]?.endsWith("copy-bench.js")) {
  void main().catch((error: unknown) => {
    // A report, not a gate: exit 0 only for completed runs; config errors still fail loudly.
    console.error(error instanceof Error ? error.message : "copy bench failed");
    process.exitCode = 1;
  });
}
