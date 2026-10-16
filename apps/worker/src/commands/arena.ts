import { appendFile, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ARENA_REJECT_REASONS,
  judgmentsFromAnswer,
  parsePairwiseJudgeAnswer,
} from "@money-maker/core/arena/pairwise-judge";
import type { PairwiseJudgment } from "@money-maker/core/arena/ranking";
import {
  type ArenaMetrics,
  buildArenaReport,
  renderArenaMarkdown,
} from "@money-maker/core/arena/report";
import { EDIT_BENCH_CORPUS } from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import { createLlamaServerPairwiseJudge } from "@money-maker/providers/llm/llama-server-pairwise-judge";
import { mulberry32 } from "./voice-bench.js";

/**
 * Model arena over an existing bench output (docs/content-generation/model-arena.md). A run
 * directory holds `arena.json`, one sub-directory of `<caseId>.png` per candidate and optional
 * `metrics.json` (candidate id -> ArenaMetrics entry, from image-bench/edit-bench summaries).
 *
 *   arena judge  <runDir>  blind VLM pairwise judge, both orders -> judgments-vlm.jsonl
 *   arena page   <runDir>  blind human A/B page -> judge.html (download judgments-human.json)
 *   arena report <runDir>  ranking, Pareto, promotion proposals -> report.json + report.md
 *
 * Never changes model policy: a proposal is advice for the owner.
 */
export type ArenaRunSpec = Readonly<{
  task: string;
  champion: string;
  candidates: readonly Readonly<{ id: string; dir: string }>[];
  /** Output kind on the blind page; absent means PNG images. */
  media?: Readonly<{ kind: "image" | "audio" | "video"; ext: string }>;
  cases: readonly Readonly<{
    caseId: string;
    brief: string;
    references?: readonly Readonly<{ kind: "product" | "character"; file: string }>[];
  }>[];
}>;

export const parseArenaRunSpec = (raw: unknown): ArenaRunSpec => {
  const spec = raw as ArenaRunSpec;
  const ok =
    spec &&
    typeof spec.task === "string" &&
    typeof spec.champion === "string" &&
    Array.isArray(spec.candidates) &&
    spec.candidates.length >= 2 &&
    spec.candidates.every((c) => typeof c.id === "string" && /^[\w.-]+$/.test(c.dir)) &&
    spec.candidates.some((c) => c.id === spec.champion) &&
    Array.isArray(spec.cases) &&
    spec.cases.every(
      (c) =>
        /^[\w.-]+$/.test(c.caseId) &&
        typeof c.brief === "string" &&
        (c.references ?? []).every(
          (r: { kind: string; file: unknown }) =>
            (r.kind === "product" || r.kind === "character") &&
            typeof r.file === "string" &&
            /^refs\/[\w.-]+$/.test(r.file),
        ),
    );
  if (!ok) throw new Error("arena_spec_invalid");
  return spec;
};

/** Every unordered candidate pair, each in both display orders. */
export const arenaPairs = (ids: readonly string[]) =>
  ids.flatMap((a, i) =>
    ids.slice(i + 1).flatMap((b) => [
      [a, b],
      [b, a],
    ]),
  ) as readonly (readonly [string, string])[];

const esc = (s: string) =>
  s.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** One random display order per case and pair; labels sit in data attributes, never on screen. */
export const buildJudgePage = (
  spec: ArenaRunSpec,
  available: ReadonlySet<string>,
  seed: number,
) => {
  const rand = mulberry32(seed);
  const media = spec.media ?? { kind: "image" as const, ext: "png" };
  const dirOf = new Map(spec.candidates.map((c) => [c.id, c.dir]));
  const ids = spec.candidates.map((c) => c.id);
  let pair = 0;
  const sections = spec.cases.flatMap((c) =>
    ids.flatMap((a, i) =>
      ids.slice(i + 1).flatMap((b) => {
        // Owner time is the scarce resource: only pairs against the champion.
        if (a !== spec.champion && b !== spec.champion) return [];
        const [left, right] = rand() < 0.5 ? [a, b] : [b, a];
        const files = [left, right].map((id) => `${dirOf.get(id)}/${c.caseId}.${media.ext}`);
        if (!files.every((f) => available.has(f))) return [];
        pair += 1;
        const show = (file: string) =>
          media.kind === "audio"
            ? `<audio controls preload="none" src="${esc(file)}"></audio>`
            : media.kind === "video"
              ? `<video controls muted loop preload="none" src="${esc(file)}"></video>`
              : `<img src="${esc(file)}">`;
        const refs = (c.references ?? [])
          .map((r) => `<img class="ref" src="${esc(r.file)}" alt="${r.kind}">`)
          .join("");
        return [
          `<section data-case="${esc(c.caseId)}" data-left="${esc(left)}" data-right="${esc(right)}"><h2>${esc(c.caseId)}</h2><p>${esc(c.brief)}</p>${refs}<div class="pair"><figure>${show(files[0] as string)}<figcaption>A</figcaption></figure><figure>${show(files[1] as string)}<figcaption>B</figcaption></figure></div><p>${[
            "left:A better",
            "right:B better",
            "tie:Tie",
            "reject_both:Reject both",
          ]
            .map((o) => {
              const [v, l] = o.split(":");
              return `<label><input type="radio" name="p${pair}" value="${v}"> ${l}</label>`;
            })
            .join(
              " ",
            )}</p><p class="reasons">${ARENA_REJECT_REASONS.map((r) => `<label><input type="checkbox" value="${r}"> ${r}</label>`).join(" ")}</p></section>`,
        ];
      }),
    ),
  );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Arena judge</title><style>body{font:15px system-ui;max-width:72rem;margin:1rem auto;padding:0 1rem}section{border-top:1px solid #ccc;padding:.5rem 0}.pair{display:flex;gap:1rem}figure{margin:0;flex:1}.pair img,.pair video,.pair audio{width:100%}.ref{height:120px;margin-right:.5rem}.reasons{font-size:12px}</style><h1>${esc(spec.task)}: blind pairwise (seed ${seed})</h1><p>Pick the better image for publishing. Model names are hidden. Download when done and save as judgments-human.json in the run directory.</p>${sections.join("")}<p><button id="dl">Download judgments</button></p><script>
document.getElementById("dl").onclick=()=>{const out=[...document.querySelectorAll("section")].flatMap(s=>{const v=s.querySelector("input[type=radio]:checked");return v?[{caseId:s.dataset.case,left:s.dataset.left,right:s.dataset.right,winner:v.value,judge:"human",reasons:[...s.querySelectorAll(".reasons input:checked")].map(i=>i.value)}]:[]});const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:"application/json"}));a.download="judgments-human.json";a.click()};
</script></html>`;
};

const readJsonl = async (path: string): Promise<PairwiseJudgment[]> =>
  (await readFile(path, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PairwiseJudgment);

const png = async (path: string) => ({
  bytes: new Uint8Array(await readFile(path)),
  mimeType: "image/png",
});

/**
 * Arena spec from the edit-bench corpus: the case prompt is the brief, and the character sheet and
 * product photo (edit-bench's `refs/<assetId>.bin` cache) are the judge's references.
 */
export const specFromEditBench = (
  input: Readonly<{
    task: string;
    champion: string;
    candidates: readonly Readonly<{ id: string; dir: string }>[];
    caseIds: readonly string[];
  }>,
): ArenaRunSpec =>
  parseArenaRunSpec({
    task: input.task,
    champion: input.champion,
    candidates: input.candidates,
    cases: input.caseIds.map((caseId) => {
      const c = EDIT_BENCH_CORPUS.find((item) => item.id === caseId);
      if (!c) throw new Error("arena_case_unknown");
      return {
        caseId,
        brief: c.prompt,
        references: [
          { kind: "character", file: `refs/${c.references[0]}.bin` },
          { kind: "product", file: `refs/${c.references[1]}.bin` },
        ],
      };
    }),
  });

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const USAGE =
  "usage: arena.js init <runDir> --task=<id> --refs=<edit-bench refs dir> --cases=a,b --candidates=<id>=<dir>,... (first is champion) | judge|page|report <runDir>";

const init = async (runDir: string, args: readonly string[]) => {
  const candidates = (flag(args, "candidates") ?? "").split(",").map((pair) => {
    const at = pair.lastIndexOf("=");
    return { id: pair.slice(0, at), dir: pair.slice(at + 1) };
  });
  const spec = specFromEditBench({
    task: flag(args, "task") ?? "image.character_product",
    champion: candidates[0]?.id ?? "",
    candidates,
    caseIds: (flag(args, "cases") ?? "").split(",").filter(Boolean),
  });
  const refs = flag(args, "refs");
  if (!refs) throw new Error(USAGE);
  await mkdir(join(runDir, "refs"), { recursive: true });
  for (const file of new Set(spec.cases.flatMap((c) => (c.references ?? []).map((r) => r.file))))
    await copyFile(join(refs, file.slice("refs/".length)), join(runDir, file));
  await writeFile(join(runDir, "arena.json"), JSON.stringify(spec, null, 1));
  console.log(join(runDir, "arena.json"));
};

const main = async (): Promise<void> => {
  const [command, runDir] = process.argv.slice(2);
  if (!command || !runDir) throw new Error(USAGE);
  if (command === "init") return init(runDir, process.argv.slice(4));
  const spec = parseArenaRunSpec(JSON.parse(await readFile(join(runDir, "arena.json"), "utf8")));
  const available = new Set<string>();
  for (const c of spec.candidates)
    for (const f of await readdir(join(runDir, c.dir)).catch(() => [] as string[]))
      available.add(`${c.dir}/${f}`);
  const dirOf = new Map(spec.candidates.map((c) => [c.id, c.dir]));

  if (command === "page") {
    await writeFile(join(runDir, "judge.html"), buildJudgePage(spec, available, Date.now() % 1e9));
    console.log(join(runDir, "judge.html"));
    return;
  }
  if (command === "judge") {
    const url = process.env.ARENA_JUDGE_URL?.trim();
    if (!url) throw new Error("ARENA_JUDGE_URL is not set (loopback llama-server with --mmproj)");
    const model = process.env.ARENA_JUDGE_MODEL?.trim() || "local";
    const judge = createLlamaServerPairwiseJudge({ baseUrl: url, model });
    const out = join(runDir, "judgments-vlm.jsonl");
    for (const c of spec.cases) {
      const references = await Promise.all(
        (c.references ?? []).map(async (r) => ({
          kind: r.kind,
          image: await png(join(runDir, r.file)),
        })),
      );
      for (const [left, right] of arenaPairs(spec.candidates.map((x) => x.id))) {
        const files = [left, right].map((id) => `${dirOf.get(id)}/${c.caseId}.png`);
        if (!files.every((f) => available.has(f))) continue;
        const started = performance.now();
        const answer = parsePairwiseJudgeAnswer(
          await judge
            .judge({
              brief: c.brief,
              references,
              a: await png(join(runDir, files[0] as string)),
              b: await png(join(runDir, files[1] as string)),
            })
            .catch(() => null),
        );
        const ms = Math.round(performance.now() - started);
        if (!answer) {
          console.log(
            JSON.stringify({ caseId: c.caseId, left, right, error: "judge_reply_invalid", ms }),
          );
          continue;
        }
        const rows = judgmentsFromAnswer(
          { caseId: c.caseId, left, right, judge: `vlm:${model}` },
          answer,
        );
        await appendFile(out, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
        console.log(
          JSON.stringify({ caseId: c.caseId, left, right, overall: answer.overallWinner, ms }),
        );
      }
    }
    return;
  }
  if (command === "report") {
    const human = JSON.parse(
      await readFile(join(runDir, "judgments-human.json"), "utf8").catch(() => "[]"),
    ) as PairwiseJudgment[];
    const metrics = JSON.parse(
      await readFile(join(runDir, "metrics.json"), "utf8").catch(() => "{}"),
    ) as ArenaMetrics;
    const report = buildArenaReport({
      task: spec.task,
      champion: spec.champion,
      candidates: spec.candidates.map((c) => c.id),
      judgments: [...(await readJsonl(join(runDir, "judgments-vlm.jsonl"))), ...human],
      metrics,
    });
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.json"), JSON.stringify(report, null, 1));
    await writeFile(join(runDir, "report.md"), renderArenaMarkdown(report));
    console.log(renderArenaMarkdown(report));
    return;
  }
  throw new Error(USAGE);
};

if (process.argv[1]?.endsWith("arena.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "arena failed");
    process.exitCode = 1;
  });
}
