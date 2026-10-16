import { COPY_BENCH_CORPUS } from "@money-maker/core/content/fixtures/copy-bench-corpus";
import { describe, expect, it } from "vitest";
import { runCopyBench, summarizeCopyBench } from "./copy-bench.js";

const good = {
  slides: Array.from({ length: 6 }, (_, i) => ({
    index: i + 1,
    total: 6,
    template: i === 0 ? "hero" : "benefit",
    headline: i === 0 ? "Organize a cozinha hoje" : `Motivo prático ${i + 1}`,
    claims: [],
  })),
  captions: { instagram_carousel: "Organização simples", threads: "Achado útil" },
};
const withLink = { ...good, captions: { ...good.captions, threads: "veja www.loja.com" } };
const withLinkSentence = {
  ...good,
  captions: { ...good.captions, threads: "Achado útil. Veja www.loja.com" },
};

describe("copy bench", () => {
  it("records ok, validator codes and runtime errors", async () => {
    const replies = [good, withLink, withLink, withLink];
    let n = 0;
    const copywriter = {
      draft: async () => {
        const reply = replies[n];
        n += 1;
        if (!reply) throw new Error("copywriter_http_500");
        return reply;
      },
    };
    const { rows, outputs } = await runCopyBench(copywriter, {
      runs: 1,
      cases: COPY_BENCH_CORPUS.slice(0, 3),
    });
    expect(rows.map((r) => [r.ok, r.code, r.attempts, r.error])).toEqual([
      [true, null, 1, null],
      [false, "caption_missing", 3, null],
      [false, null, 0, "runtime_error:copywriter_http_500"],
    ]);
    expect(outputs).toContain("Organize a cozinha hoje");
    const summary = summarizeCopyBench(rows, "local:x");
    expect(summary.total).toMatchObject({ rows: 3, passed: 1, runtimeErrors: 1 });
    expect(summary.codes).toEqual({ caption_missing: 1 });
    expect(summary).toMatchObject({
      gate: { schemaAndEvidencePass: false, runtimeErrors: 1 },
      promoted: false,
      humanReviewPending: true,
    });
  });

  it("reports how many hook options were offered and how many passed the gates", async () => {
    const withHooks = {
      ...good,
      hookOptions: [
        { headline: "Cozinha sem bagunça", captionFirstLine: "Tudo no lugar." },
        { headline: "Só R$ 9", captionFirstLine: "Corre." },
      ],
    };
    const { rows, outputs } = await runCopyBench(
      { draft: async () => withHooks },
      { runs: 1, cases: COPY_BENCH_CORPUS.slice(0, 1) },
    );
    expect(rows[0]).toMatchObject({ ok: true, hookOptions: 2, validHookOptions: 1 });
    expect(outputs).toContain("hook ok: Cozinha sem bagunça | Tudo no lugar.");
    expect(outputs).toContain("hook dropped: Só R$ 9 | Corre.");
    expect(summarizeCopyBench(rows, "local:x").hookOptions).toEqual({
      offered: 2,
      valid: 1,
      rowsWithValidOption: 1,
    });
  });

  it("rejects unknown placeholders before validation", async () => {
    const bad = {
      ...good,
      slides: good.slides.map((s, i) => (i === 0 ? { ...s, headline: "Só {frete}" } : s)),
    };
    const { rows } = await runCopyBench(
      { draft: async () => bad },
      { runs: 1, cases: COPY_BENCH_CORPUS.slice(0, 1) },
    );
    expect(rows[0]).toMatchObject({ code: "copy_placeholder_unknown", attempts: 3 });
  });

  it("corrects a failing draft with validator feedback", async () => {
    const bad = {
      ...good,
      slides: good.slides.map((s, i) => (i === 1 ? { ...s, headline: "Frete no cesto" } : s)),
    };
    const corrections: unknown[] = [];
    const { rows } = await runCopyBench(
      {
        draft: async (_input, correction) => {
          corrections.push(correction);
          return corrections.length === 1 ? bad : good;
        },
      },
      { runs: 1, cases: COPY_BENCH_CORPUS.slice(0, 1) },
    );
    expect(rows[0]).toMatchObject({ ok: true, attempts: 2, repairs: 0 });
    expect(corrections[1]).toMatchObject({
      previous: bad,
      problems: [expect.stringContaining('Slide 2 headline "Frete no cesto" mentions shipping')],
    });
  });

  it("repairs a draft by removing a rule-breaking sentence and records it", async () => {
    const { rows } = await runCopyBench(
      { draft: async () => withLinkSentence },
      { runs: 1, cases: COPY_BENCH_CORPUS.slice(0, 1) },
    );
    expect(rows[0]).toMatchObject({ ok: true, repairs: 1 });
  });

  it("strips model hashtags and records how many", async () => {
    const tagged = { ...good, captions: { ...good.captions, threads: "Achado útil #casa #dica" } };
    const { rows } = await runCopyBench(
      { draft: async () => tagged },
      { runs: 1, cases: COPY_BENCH_CORPUS.slice(0, 1) },
    );
    expect(rows[0]).toMatchObject({ ok: true, strippedHashtags: 2 });
  });

  it("ships 9 cases, 3 per niche", () => {
    expect(COPY_BENCH_CORPUS).toHaveLength(9);
    for (const niche of ["casa", "beleza", "tech"])
      expect(COPY_BENCH_CORPUS.filter((c) => c.niche === niche)).toHaveLength(3);
  });

  it("gates production on every case passing at least 90% of loop runs", () => {
    const row = (caseId: string, ok: boolean) => ({
      caseId,
      niche: "casa",
      run: 1,
      ok,
      code: ok ? null : "number_unsupported",
      latencyMs: 1,
      attempts: ok ? 1 : 3,
      strippedHashtags: 0,
      repairs: 0,
      hookOptions: 0,
      validHookOptions: 0,
      error: null,
    });
    const summary = summarizeCopyBench(
      [row("a", true), row("a", false), row("b", true), row("b", true)],
      "local:x",
    );
    expect(summary.perCase).toEqual({ a: { passRate: 0.5 }, b: { passRate: 1 } });
    expect(summary.gate).toMatchObject({ worstCasePassRate: 0.5, productionReady: false });
    const ready = summarizeCopyBench(
      Array.from({ length: 10 }, (_, i) => row("a", i > 0)),
      "x",
    );
    expect(ready.gate.productionReady).toBe(true);
  });
});
