import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeSceneSvg } from "@money-maker/core/explainer/compose-scene";
import {
  DEFAULT_SCENE_PALETTE,
  readExplainerContext,
} from "@money-maker/core/explainer/explainer-context";
import { FRAME } from "@money-maker/core/explainer/layout";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { rasterizeSvg } from "@money-maker/providers/media/svg-rasterizer";
import { describe, expect, it } from "vitest";
import { reviewSheetFor } from "./director-review-init.js";
import {
  type Bench,
  buildReviewPack,
  caseDirName,
  parseBench,
  parseReviewSheet,
  type Rasterize,
  reviewValueError,
  runReviewPack,
  writeReviewPack,
} from "./director-review-pack.js";

const alex = {
  key: "alex",
  name: "Alex",
  role: "main",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#161616", fill: "#FFFFFF", accent: "#FF5A36" },
  accessory: "cap",
};
const BODY = "Pagou caro. Olha o preço. Compare antes. </script><b>x</b>";
const scene = (index: number, fromChar: number, toChar: number, over: Partial<SceneSpec> = {}) =>
  ({
    index,
    fromChar,
    toChar,
    purpose: index === 1 ? "hook" : "explanation",
    background: "store",
    actors: [
      {
        characterKey: "alex",
        pose: "neutral",
        expression: "neutral",
        position: "center",
        actions: [{ type: "walk_to", atWord: 0, to: "right" }],
      },
    ],
    props: [],
    overlays: [],
    camera: { shot: "medium", movement: "none" },
    transition: "hard_cut",
    captionMode: "word",
    ...over,
  }) as SceneSpec;
const SCENES = [
  scene(1, 0, 11),
  scene(2, 12, 25, { camera: { shot: "close", movement: "slow_zoom_in" } }),
  scene(3, 26, BODY.length, {
    props: [{ type: "money_stack", position: "right", label: "R$ 10" }],
  }),
];
const fixture = (id: string) => ({
  id,
  case: "approved",
  source: `production:${id}`,
  language: "pt-BR",
  body: BODY,
  claims: [],
  beats: [],
  cast: ["alex"],
  expected: { validator: "pass" },
  characters: [alex],
});
const bench = (): Bench =>
  parseBench(
    {
      model: "empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M",
      candidate: { runtime: "llama.cpp", quantization: "Q4_K_M" },
      provenance: { modelVerified: true },
      split: "holdout",
      gate: { productionScripts: true },
      runs: [
        {
          fixture: fixture("case-b"),
          result: { ok: true, scenes: SCENES, attempts: [] },
          latencyMs: 900,
        },
        {
          fixture: fixture("../../etc/passwd"),
          result: {
            ok: false,
            reason: "scene_rejected",
            attempts: [{ reason: "scene_rejected", errors: ["x"], issues: [] }],
          },
          latencyMs: 1200,
        },
        {
          fixture: fixture("case-a"),
          result: { ok: true, scenes: [SCENES[0]], attempts: [] },
          latencyMs: 700,
        },
      ],
      cases: ["case-b", "../../etc/passwd", "case-a"].map((case_id, i) => ({
        case_id,
        accepted: i !== 1,
        retry_count: i === 1 ? 1 : 0,
        latency_ms: [900, 1200, 700][i],
        validation_failures: i === 1 ? ["scene_rejected"] : [],
      })),
    },
    "bench.json",
  );
const fakeRasterize = () => {
  const calls: { svg: string; size: unknown }[] = [];
  const rasterize: Rasterize = async (svg, size) => {
    calls.push({ svg, size });
    return new TextEncoder().encode(`png:${calls.length}`);
  };
  return { calls, rasterize };
};
const template = (b: Bench) => reviewSheetFor(b, "bench.json", new Date(0));

describe("buildReviewPack", () => {
  it("keeps every run, in order, with exactly the benchmark's final scenes", async () => {
    const b = bench();
    const { rasterize } = fakeRasterize();
    const pack = await buildReviewPack(b, "bench.json", template(b), rasterize);
    expect(pack.manifest.cases.map((c) => c.case_id)).toEqual([
      "case-b",
      "../../etc/passwd",
      "case-a",
    ]);
    const [first, rejected, last] = pack.manifest.cases;
    expect(first?.candidates[0]?.scenes.map((s) => s.spec)).toEqual(SCENES);
    expect(last?.candidates[0]?.scenes.map((s) => s.spec)).toEqual([SCENES[0]]);
    expect(rejected?.candidates[0]).toMatchObject({
      accepted: false,
      failure_reason: "scene_rejected",
      retry_count: 1,
      scenes: [],
    });
    expect(rejected?.candidates[0]?.attempts).toHaveLength(1);
    expect(first?.candidates[0]).toMatchObject({
      id: "A",
      accepted: true,
      retry_count: 0,
      latency_ms: 900,
      provenance: { model: b.model, modelVerified: true, quantization: "Q4_K_M" },
    });
  });

  it("cuts each scene's script excerpt at fromChar/toChar", async () => {
    const b = bench();
    const pack = await buildReviewPack(b, "bench.json", template(b), fakeRasterize().rasterize);
    expect(pack.manifest.cases[0]?.candidates[0]?.scenes.map((s) => s.script)).toEqual([
      "Pagou caro.",
      "Olha o preço.",
      BODY.slice(26),
    ]);
  });

  it("rasterizes one frame per scene from the same svg preview_video_storyboard composes", async () => {
    const b = bench();
    const { calls, rasterize } = fakeRasterize();
    const pack = await buildReviewPack(b, "bench.json", template(b), rasterize);
    const characters =
      readExplainerContext({ kind: "media", context: { characters: [alex] } })?.characters ?? [];
    const expected = [...SCENES, SCENES[0]].map((s) =>
      composeSceneSvg(s as SceneSpec, { characters, palette: DEFAULT_SCENE_PALETTE }),
    );
    expect(calls.map((c) => c.svg)).toEqual(expected);
    expect(calls.every((c) => c.size === FRAME)).toBe(true);
    expect([...pack.images.keys()]).toEqual([
      "cases/01-case-b/scene-01.png",
      "cases/01-case-b/scene-02.png",
      "cases/01-case-b/scene-03.png",
      "cases/03-case-a/scene-01.png",
    ]);
  });

  it("records a scene whose character is missing instead of failing the pack", async () => {
    const b = bench();
    const broken = {
      ...b,
      runs: [{ ...b.runs[0]!, fixture: { ...b.runs[0]!.fixture, characters: [] } }],
    };
    const pack = await buildReviewPack(
      broken,
      "bench.json",
      template(b),
      fakeRasterize().rasterize,
    );
    expect(pack.manifest.cases[0]?.candidates[0]?.scenes[0]).toMatchObject({
      image: null,
      error: "scene_character_missing:1",
    });
  });
});

describe("reviewValueError", () => {
  it("accepts only 1..5 or null for scores", () => {
    for (const value of [1, 2, 3, 4, 5, null])
      expect(reviewValueError("story_coherence", value)).toBeNull();
    for (const value of [0, 6, 2.5, "3", "n/a", undefined])
      expect(reviewValueError("scene_continuity", value)).not.toBeNull();
  });
  it('accepts "n/a" only for product_visibility', () => {
    expect(reviewValueError("product_visibility", "n/a")).toBeNull();
    expect(reviewValueError("product_visibility", 4)).toBeNull();
    expect(reviewValueError("commercial_intent", "n/a")).not.toBeNull();
    expect(reviewValueError("product_visibility", "N/A")).not.toBeNull();
  });
  it("accepts only the three editorial decisions", () => {
    for (const value of ["pass", "needs_fix", "fail", null])
      expect(reviewValueError("editorial_decision", value)).toBeNull();
    for (const value of ["approve", "PASS", 1])
      expect(reviewValueError("editorial_decision", value)).not.toBeNull();
  });
  it("checks minutes, notes and unknown fields", () => {
    expect(reviewValueError("manual_fix_minutes", 0)).toBeNull();
    expect(reviewValueError("manual_fix_minutes", 12.5)).toBeNull();
    expect(reviewValueError("manual_fix_minutes", -1)).not.toBeNull();
    expect(reviewValueError("manual_fix_minutes", "5")).not.toBeNull();
    expect(reviewValueError("notes", "")).toBeNull();
    expect(reviewValueError("notes", null)).not.toBeNull();
    expect(reviewValueError("score", 1)).not.toBeNull();
  });
});

describe("parseReviewSheet", () => {
  it("keeps filled cases, fills missing ones and preserves case ids", () => {
    const b = bench();
    const filled = { ...template(b).cases[2]!, story_coherence: 4, notes: "ok" };
    const sheet = parseReviewSheet({ model: "m", cases: [filled] }, b, "r.json");
    expect(sheet.cases.map((c) => c.case_id)).toEqual(b.cases.map((c) => c.case_id));
    expect(sheet.cases[2]).toMatchObject({ story_coherence: 4, notes: "ok" });
    expect(sheet.cases[0]).toMatchObject({ story_coherence: null, notes: "" });
    expect(sheet.model).toBe("m");
  });
  it("rejects unknown cases and invalid values", () => {
    const b = bench();
    const valid = template(b).cases[0]!;
    expect(() =>
      parseReviewSheet({ cases: [{ ...valid, case_id: "other" }] }, b, "r.json"),
    ).toThrow(/not in the benchmark/);
    expect(() =>
      parseReviewSheet({ cases: [{ ...valid, story_coherence: 7 }] }, b, "r.json"),
    ).toThrow(/story_coherence/);
    expect(() => parseReviewSheet({}, b, "r.json")).toThrow(/not a director review sheet/);
  });
});

describe("paths", () => {
  it("sanitizes case folder names", () => {
    expect(caseDirName(1, "../../etc/passwd")).toBe("02-______etc_passwd");
    expect(caseDirName(0, "a/b\\c")).not.toMatch(/[/\\.]/);
  });
  it("never writes outside the pack", async () => {
    const out = join(await mkdtemp(join(tmpdir(), "review-pack-")), "pack");
    const b = bench();
    const pack = await buildReviewPack(b, "bench.json", template(b), fakeRasterize().rasterize);
    const evil = { ...pack, images: new Map([["../escape.png", new Uint8Array([1])]]) };
    await expect(writeReviewPack(out, evil)).rejects.toThrow(/escapes the pack/);
  });
  it("refuses a non-empty folder that is not a review pack", async () => {
    const out = await mkdtemp(join(tmpdir(), "review-pack-"));
    await writeFile(join(out, "keep.txt"), "mine");
    const b = bench();
    const pack = await buildReviewPack(b, "bench.json", template(b), fakeRasterize().rasterize);
    await expect(writeReviewPack(out, pack)).rejects.toThrow(/not a review pack/);
    expect(await readFile(join(out, "keep.txt"), "utf8")).toBe("mine");
  });
});

describe("runReviewPack", () => {
  const setup = async (withReview: boolean) => {
    const dir = await mkdtemp(join(tmpdir(), "review-pack-"));
    await mkdir(join(dir, "bench"));
    const benchPath = join(dir, "bench", "holdout-q.json");
    const benchText = JSON.stringify(bench(), null, 1);
    await writeFile(benchPath, benchText);
    const reviewPath = benchPath.replace(/\.json$/, ".review.json");
    const reviewText = JSON.stringify({
      ...reviewSheetFor(bench(), benchPath, new Date(0)),
      cases: [{ ...template(bench()).cases[0]!, product_visibility: "n/a", manual_fix_minutes: 3 }],
    });
    if (withReview) await writeFile(reviewPath, reviewText);
    return { dir, benchPath, benchText, reviewPath, reviewText };
  };
  const files = async (root: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        out[path.slice(root.length)] = (await readFile(path)).toString("base64");
      }
    return out;
  };

  it("writes real PNG stills, the page and the sheet without touching the inputs", async () => {
    const { dir, benchPath, benchText, reviewPath, reviewText } = await setup(true);
    const out = join(dir, "pack");
    const result = await runReviewPack(benchPath, out, rasterizeSvg);
    expect(result).toMatchObject({ cases: 3, scenes: 4, review: reviewPath });
    expect(await readFile(benchPath, "utf8")).toBe(benchText);
    expect(await readFile(reviewPath, "utf8")).toBe(reviewText);

    const png = await readFile(join(out, "cases/01-case-b/scene-01.png"));
    expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(FRAME.width);
    expect(png.readUInt32BE(20)).toBe(FRAME.height);

    const sheet = JSON.parse(await readFile(join(out, "review.json"), "utf8"));
    expect(sheet.cases.map((c: { case_id: string }) => c.case_id)).toEqual(
      bench().cases.map((c) => c.case_id),
    );
    expect(sheet.cases[0]).toMatchObject({ product_visibility: "n/a", manual_fix_minutes: 3 });

    const html = await readFile(join(out, "index.html"), "utf8");
    expect(html).toContain("var reviewValueError = ");
    expect(html).not.toContain("</script><b>");
    expect(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")).kind).toBe(
      "director-review-pack",
    );
  });

  it("starts from a review-init template when no sheet exists", async () => {
    const { dir, benchPath } = await setup(false);
    const out = join(dir, "pack");
    const result = await runReviewPack(benchPath, out, fakeRasterize().rasterize, new Date(0));
    expect(result.review).toBeNull();
    const sheet = JSON.parse(await readFile(join(out, "review.json"), "utf8"));
    expect(sheet).toEqual(reviewSheetFor(bench(), benchPath, new Date(0)));
  });

  it("is deterministic and replaces an earlier pack", async () => {
    const { dir, benchPath } = await setup(true);
    const out = join(dir, "pack");
    await runReviewPack(benchPath, out, rasterizeSvg);
    const first = await files(out);
    await runReviewPack(benchPath, out, rasterizeSvg);
    expect(await files(out)).toEqual(first);
  });
});

describe("offline boundary", () => {
  it("imports no scene director, database or object storage module", async () => {
    const source = await readFile(new URL("./director-review-pack.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.filter((i) => /llm|llama|database|prisma|storage|r2/.test(i ?? ""))).toEqual([]);
  });
});
