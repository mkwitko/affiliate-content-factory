import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { profileIdOf } from "@money-maker/core/arena/catalog";
import type { CaseResult } from "@money-maker/core/arena/leaderboard";
import { copyCaseFromReal, realProductsInterleaved } from "@money-maker/core/arena/real-dataset";
import { COPY_BENCH_CORPUS } from "@money-maker/core/content/fixtures/copy-bench-corpus";
import { createLlamaServerCopywriter } from "@money-maker/providers/llm/llama-server-copywriter";
import { runCopyBench } from "../../commands/copy-bench.js";
import { startLlama } from "../servers.js";
import { okResult, type Suite } from "../suite.js";

/**
 * Affiliate copy through the production loop (repair + up to 2 corrections) on the 9-product
 * corpus. QA is the production validator: schema, verified numbers only, no invented shipping or
 * discount, caption limits, hashtags. A case scores the share of its runs that pass; runs at
 * temperature 0.7 so repeats measure stability (smoke 1 run on 6 products, qualification 2 on 9,
 * full 3 on 9). outputs.md keeps the copy for the owner to read for invented features.
 */
const STAGES = {
  smoke: { runs: 1, cases: 6 },
  qualification: { runs: 2, cases: 9 },
  full: { runs: 3, cases: 9 },
} as const;
/** Real products (26): smoke 6, qualification 2 runs on 18, full 3 runs on all. */
const REAL_STAGES = {
  smoke: { runs: 1, cases: 6 },
  qualification: { runs: 2, cases: 18 },
  full: { runs: 3, cases: 26 },
} as const;

export const llmCopySuite: Suite = {
  task: "llm.offer_copy",
  media: { kind: "text", ext: "md" },
  async run(context) {
    const { env, candidate, outDir, dir, stage } = context;
    const server = await startLlama(env, candidate);
    try {
      const real = env.dataset === "real";
      const plan = real ? REAL_STAGES[stage] : STAGES[stage];
      // Niches interleaved, so a smoke run covers casa, beleza and tech.
      const ordered = real
        ? realProductsInterleaved().map(copyCaseFromReal)
        : [0, 3, 6, 1, 4, 7, 2, 5, 8].flatMap((i) => COPY_BENCH_CORPUS[i] ?? []);
      const copywriter = createLlamaServerCopywriter({
        baseUrl: server.baseUrl,
        model: profileIdOf(candidate.id),
        temperature: plan.runs > 1 ? 0.7 : 0,
      });
      const { rows, outputs } = await runCopyBench(copywriter, {
        runs: plan.runs,
        cases: ordered.slice(0, plan.cases),
      });
      await mkdir(join(outDir, dir), { recursive: true });
      await writeFile(join(outDir, dir, "outputs.md"), outputs);
      const cases: CaseResult[] = [...new Set(rows.map((r) => r.caseId))].map((caseId) => {
        const own = rows.filter((r) => r.caseId === caseId);
        return {
          caseId,
          metrics: {
            failed: own.every((r) => r.error !== null) ? 1 : 0,
            passRate: own.filter((r) => r.ok).length / own.length,
            attempts: own.reduce((s, r) => s + r.attempts, 0) / own.length,
          },
        };
      });
      const perCase = cases.map((c) => c.metrics.passRate ?? 0);
      return okResult(context, cases, {
        latenciesMs: rows.map((r) => r.latencyMs),
        peakRamMb: await server.peakRamMb(),
        aggregate: {
          passRate: rows.filter((r) => r.ok).length / Math.max(1, rows.length),
          worstCasePassRate: perCase.length ? Math.min(...perCase) : 0,
          runtimeErrorRate: rows.filter((r) => r.error !== null).length / Math.max(1, rows.length),
          validHookShare:
            rows.reduce((s, r) => s + r.validHookOptions, 0) /
            Math.max(
              1,
              rows.reduce((s, r) => s + r.hookOptions, 0),
            ),
        },
      });
    } finally {
      await server.stop();
    }
  },
};
