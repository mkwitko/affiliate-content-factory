import { EDIT_BENCH_CORPUS } from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import { describe, expect, it } from "vitest";
import {
  buildPairs,
  buildSubjectPairs,
  FIDELITY_CASES,
  runFidelityBench,
  subjectSidecars,
  summarizeFidelityBench,
} from "./fidelity-bench.js";

const image = { bytes: new Uint8Array([1]), mimeType: "image/png" };
const answer = (same: boolean, counts: Record<string, number | null> = {}) => ({
  productPresent: true,
  sameProductAsReference: same,
  counts,
  inventedTextOrLogo: false,
  notes: "",
});
const colourOk = async () => [{ productShare: 0.9, scenePresence: 0.1 }];

describe("buildPairs", () => {
  it("builds 6 positives and 12 negatives from the corpus", () => {
    const pairs = buildPairs(FIDELITY_CASES);
    expect(pairs.filter((pair) => pair.kind === "positive")).toHaveLength(6);
    expect(pairs.filter((pair) => pair.kind === "negative")).toHaveLength(12);
    expect(new Set(pairs.map((pair) => pair.pairId)).size).toBe(18);
  });
});

describe("runFidelityBench", () => {
  const run = (
    compare: (input: {
      spec: { features: readonly { key: string; value: number }[] };
    }) => Promise<unknown>,
  ) =>
    runFidelityBench({
      pairs: buildPairs(FIDELITY_CASES),
      loadScene: async () => image,
      loadReference: async () => image,
      compare: compare as never,
      colour: colourOk,
    });

  it("meets the gate when the VLM separates right from swapped, answering the counted keys", async () => {
    let call = 0;
    const kinds = buildPairs(FIDELITY_CASES).map((pair) => pair.kind);
    const rows = await run(async ({ spec }) => {
      const same = kinds[call++] === "positive";
      return answer(same, Object.fromEntries(spec.features.map((f) => [f.key, f.value])));
    });
    const summary = summarizeFidelityBench(rows);
    expect(summary).toMatchObject({
      promoted: false,
      positives: { total: 6, accepted: 6 },
      negatives: { total: 12, blocked: 12, falseAccepts: 0 },
      parseFailures: 0,
      gate: { met: true },
    });
  });
  it("counts parse failures and VLM errors as not accepted and never as blocked", async () => {
    let call = 0;
    const rows = await run(async () => {
      call += 1;
      if (call === 1) throw new Error("fidelity_vlm_http_500");
      return "not json";
    });
    const summary = summarizeFidelityBench(rows);
    expect(rows[0]?.error).toBe("fidelity_vlm_http_500");
    expect(summary.parseFailures).toBe(18);
    expect(summary.positives.accepted).toBe(0);
    expect(summary.negatives.blocked).toBe(0);
    expect(summary.gate.met).toBe(false);
  });
  it("records subject boxes in rows and writes sidecars only from positive pairs", async () => {
    const face = { kind: "face", box: [400, 80, 600, 280] } as const;
    const rows = await run(async ({ spec }) => ({
      ...answer(true, Object.fromEntries(spec.features.map((f) => [f.key, f.value]))),
      subjects: [face],
    }));
    expect(rows.every((row) => row.subjects?.[0]?.kind === "face")).toBe(true);
    const sidecars = subjectSidecars(rows);
    expect(sidecars).toHaveLength(6);
    expect(sidecars[0]).toEqual({ caseId: FIDELITY_CASES[0]?.id, subjects: [face] });
  });
  it("pairs reel scenes with their own product only, and keeps them out of the summary", async () => {
    const reel = buildSubjectPairs(
      EDIT_BENCH_CORPUS.filter((item) => /_(problem|result)$/.test(item.id)),
    );
    expect(reel).toHaveLength(6);
    expect(reel.every((pair) => pair.kind === "subjects")).toBe(true);
    const face = { kind: "face", box: [400, 80, 600, 280] } as const;
    const rows = await runFidelityBench({
      pairs: [...buildPairs(FIDELITY_CASES), ...reel],
      loadScene: async () => image,
      loadReference: async () => image,
      compare: (async ({
        spec,
      }: {
        spec: { features: readonly { key: string; value: number }[] };
      }) => ({
        ...answer(true, Object.fromEntries(spec.features.map((f) => [f.key, f.value]))),
        subjects: [face],
      })) as never,
      colour: colourOk,
    });
    expect(subjectSidecars(rows).map((s) => s.caseId)).toContain("casa_problem");
    const base = summarizeFidelityBench(rows.filter((row) => row.kind !== "subjects"));
    expect(summarizeFidelityBench(rows)).toEqual(base);
  });
  it("flags a false accept on a swapped product", async () => {
    const rows = await run(async ({ spec }) =>
      answer(true, Object.fromEntries(spec.features.map((f) => [f.key, f.value]))),
    );
    expect(summarizeFidelityBench(rows).negatives.falseAccepts).toBe(12);
  });
});
