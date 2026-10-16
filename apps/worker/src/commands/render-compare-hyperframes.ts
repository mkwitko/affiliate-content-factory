// apps/worker/src/commands/render-compare-hyperframes.ts
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SpokenWord } from "@money-maker/core/assets/speech-synthesizer";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
} from "@money-maker/core/explainer/explainer-context";
import { COST_CURIOUS_CAST } from "@money-maker/core/explainer/fixtures/cast/cost-curious-cast";
import { GOUACHE_V1 } from "@money-maker/core/explainer/fixtures/visual-language/gouache-v1";
import { type MotionPlan, planMotion } from "@money-maker/core/explainer/motion/plan";
import type { SceneSpec } from "@money-maker/core/explainer/scene-spec";
import { readVisualLanguageProfile } from "@money-maker/core/explainer/visual-language";
import { configureBundledFonts } from "@money-maker/providers/media/fonts";
import {
  createHyperFramesRenderer,
  HYPERFRAMES_VERSION,
} from "@money-maker/providers/media/hyperframes-renderer";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";
import {
  createStickmanMotionRenderer,
  type StickmanMotionRenderInput,
} from "@money-maker/providers/media/stickman-motion-renderer";
import { actor, base, LOCATION } from "./render-bench-long.js";

/**
 * `pnpm render:compare-hyperframes [--seconds=6] [--out=artifacts/hyperframes-comparison]`:
 * the same eight MotionPlans, the same narration bytes, rendered by the production stickman
 * renderer and by the experimental HyperFrames one, plus a blind A/B page. Local only; writes
 * files and a manifest, publishes nothing, touches no database.
 */
const exec = promisify(execFile);
const LEAD_IN_MS = 200;
const TAIL_MS = 300;
const VISUAL_LANGUAGE = readVisualLanguageProfile(GOUACHE_V1) ?? undefined;

type Template = Omit<SceneSpec, "index" | "fromChar" | "toChar">;
export type CompareCase = Readonly<{
  id: string;
  title: string;
  text: string;
  template: Template;
  voiceId: string;
}>;

const NARRATOR = "af_heart";
const SAM_VOICE = "am_michael";

/** Illustrative fixture numbers only; no claim here is a product fact. */
export const COMPARE_CASES: readonly CompareCase[] = [
  {
    id: "hook",
    title: "Hook",
    text: "Why does the same coffee cost more at the airport",
    voiceId: NARRATOR,
    template: {
      ...base,
      purpose: "hook",
      layoutId: "SOLO_CENTER",
      overlays: [{ text: "WHY MORE?", position: "top", emphasis: true }],
      actors: [actor("center", "sam")],
    },
  },
  {
    id: "sam_character",
    title: "Sam character shot",
    text: "Sam points at the receipt and asks what the extra line is",
    voiceId: SAM_VOICE,
    template: {
      ...base,
      layoutId: "ACTOR_LEFT_PROP_RIGHT",
      actors: [actor("left", "sam", "pointing")],
      props: [{ type: "document", position: "right", label: "Receipt" }],
    },
  },
  {
    id: "price_reveal",
    title: "Number reveal",
    text: "The fee grows step by step until it reaches the final figure",
    voiceId: NARRATOR,
    template: {
      ...base,
      layoutId: "ACTOR_DIAGRAM_SPLIT",
      actors: [actor("right", "sam")],
      diagram: { kind: "counter", from: 0, to: 30, unit: "%" },
    },
  },
  {
    id: "diagram",
    title: "Flow diagram",
    text: "An order becomes a fee and the fee becomes the total",
    voiceId: NARRATOR,
    template: {
      ...base,
      layoutId: "ACTOR_DIAGRAM_SPLIT",
      actors: [actor("left", "sam")],
      diagram: {
        kind: "flow",
        nodes: [
          { id: "a", label: "Order" },
          { id: "b", label: "Fee" },
          { id: "c", label: "Total" },
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
      },
    },
  },
  {
    id: "comparison",
    title: "Comparison",
    text: "Compare the two options side by side before you decide",
    voiceId: NARRATOR,
    template: {
      ...base,
      layoutId: "ACTOR_DIAGRAM_SPLIT",
      actors: [actor("center", "sam")],
      diagram: {
        kind: "bar_compare",
        items: [
          { label: "Option A", value: 40 },
          { label: "Option B", value: 70 },
        ],
      },
    },
  },
  {
    id: "location_shot",
    title: "Location shot",
    text: "Two people talk at the desk while the numbers sit in the background",
    voiceId: NARRATOR,
    template: {
      ...base,
      background: "office",
      layoutId: "WIDE_ENVIRONMENT",
      locationId: LOCATION.id,
      zoneId: "desk",
      camera: { shot: "wide", movement: "pan_left" },
      actors: [actor("left", "sam"), actor("center", "bia")],
    },
  },
  {
    id: "information_heavy",
    title: "Information-heavy",
    text: "Three dates, one label and one prop all compete for attention here",
    voiceId: NARRATOR,
    template: {
      ...base,
      layoutId: "ACTOR_DIAGRAM_SPLIT",
      actors: [actor("left", "sam")],
      props: [{ type: "document", position: "right", label: "Terms" }],
      overlays: [{ text: "READ THE FINE PRINT", position: "top" }],
      diagram: {
        kind: "timeline",
        points: [
          { label: "Order", at: "Day 1" },
          { label: "Charge", at: "Day 3" },
          { label: "Refund", at: "Day 9" },
        ],
      },
    },
  },
  {
    id: "payoff",
    title: "Payoff",
    text: "Now you know where the extra cost comes from",
    voiceId: NARRATOR,
    template: {
      ...base,
      purpose: "payoff",
      layoutId: "ACTOR_RIGHT_TEXT_LEFT",
      actors: [actor("right", "sam")],
      overlays: [{ text: "THE POINT", position: "middle", emphasis: true }],
    },
  },
];

export type CompareVoice = Readonly<{
  durationMs: number;
  words?: readonly SpokenWord[] | undefined;
}>;

/** One scene per case on the landscape canvas, built like buildLongBenchPlan. */
export const buildComparePlan = (
  c: CompareCase,
  seconds: number,
  voice?: CompareVoice,
): Readonly<{ plan: MotionPlan; voiceStartMs: readonly number[]; voiceMs: number }> => {
  const tokens = c.text.split(" ");
  const voiceMs = voice?.durationMs ?? Math.max(500, seconds * 1000 - LEAD_IN_MS - TAIL_MS);
  const sceneMs = Math.max(Math.round(seconds * 1000), LEAD_IN_MS + voiceMs + TAIL_MS);
  const step = voiceMs / tokens.length;
  const words =
    voice?.words && voice.words.length
      ? voice.words.map((w) => ({
          text: w.text,
          startMs: LEAD_IN_MS + w.startMs,
          endMs: LEAD_IN_MS + w.endMs,
        }))
      : tokens.map((word, i) => ({
          text: word,
          startMs: Math.round(LEAD_IN_MS + i * step),
          endMs: Math.round(LEAD_IN_MS + (i + 1) * step - 40),
        }));
  const scene: SceneSpec = { ...c.template, index: 1, fromChar: 0, toChar: c.text.length };
  const plan = planMotion({
    scenes: [scene],
    timings: [
      {
        startMs: 0,
        endMs: sceneMs,
        voiceStartMs: LEAD_IN_MS,
        voiceEndMs: LEAD_IN_MS + voiceMs,
        text: c.text,
        words,
      },
    ],
    characters: COST_CURIOUS_CAST as readonly ExplainerCharacter[],
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: 3,
    durationMs: sceneMs,
    canvas: "landscape",
    locations: [LOCATION],
    variationSeed: "hyperframes-compare",
    ...(VISUAL_LANGUAGE
      ? { visualLanguage: VISUAL_LANGUAGE, compositing: VISUAL_LANGUAGE.compositing }
      : {}),
  });
  return { plan, voiceStartMs: [LEAD_IN_MS], voiceMs };
};

const mulberry32 = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let r = Math.imul(s ^ (s >>> 15), 1 | s);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4_294_967_296;
  };
};
const seedOf = (text: string): number =>
  [...text].reduce((sum, ch) => (Math.imul(sum, 31) + ch.charCodeAt(0)) >>> 0, 7);

export type RendererName = "stickman" | "hyperframes";
/** Seeded shuffle: which renderer is shown as A for each case. */
export const blindOrder = (
  seed: string,
  ids: readonly string[],
): Record<string, readonly [RendererName, RendererName]> => {
  const random = mulberry32(seedOf(seed));
  return Object.fromEntries(
    ids.map((id) => [
      id,
      random() < 0.5
        ? (["stickman", "hyperframes"] as const)
        : (["hyperframes", "stickman"] as const),
    ]),
  );
};

export const QUESTIONS = [
  "Which looks more professional?",
  "Which communicates faster?",
  "Which is easier to watch for 8-14 minutes?",
  "Which has better information hierarchy?",
  "Which feels less template-generated?",
] as const;

export type Metrics = Readonly<{
  ok: boolean;
  error?: string;
  wallMs: number | null;
  frames: number | null;
  fps: number | null;
  durationMs: number | null;
  outputBytes: number | null;
  encodeMs: number | null;
  chromeStartupMs: number | null;
  peakRssMb: number;
}>;
type CaseResult = Readonly<{
  id: string;
  title: string;
  text: string;
  voiceId: string;
  stickman: Metrics;
  hyperframes: Metrics;
}>;
export type Manifest = Readonly<{
  generatedAt: string;
  seconds: number;
  voice: "tone" | "kokoro";
  hyperframesVersion: string;
  node: string;
  notes: readonly string[];
  order: Readonly<Record<string, readonly [RendererName, RendererName]>>;
  cases: readonly CaseResult[];
  renderers: Readonly<
    Record<
      RendererName,
      Readonly<{
        okCases: number;
        meanWallMs: number | null;
        totalBytes: number;
        chromeStartupMs: number | null;
        peakRssMb: number;
      }>
    >
  >;
}>;

/** Self-contained blind page: neutral file names, seeded A/B order, reveal toggle, JSON export. */
export const renderIndexHtml = (manifest: Manifest): string => {
  const data = JSON.stringify({
    seed: "hyperframes-ab-v1",
    questions: QUESTIONS,
    cases: manifest.cases.map((c) => ({ id: c.id, title: c.title, text: c.text })),
    order: manifest.order,
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Renderer blind A/B</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf7;--fg:#161616;--card:#fff;--line:#d9d2c5;--accent:#ff5a36}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#f4f1ea;--card:#222;--line:#444}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto}
.case{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:20px 0}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
video{width:100%;border-radius:8px;background:#000}
fieldset{border:0;padding:0;margin:12px 0}
legend{font-weight:600}
label{margin-right:16px}
button{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
.reveal{color:var(--accent);font-weight:700}
.bar{position:sticky;top:0;background:var(--bg);padding:8px 0;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
</style></head><body><main>
<h1>Renderer blind A/B</h1>
<p>Same plan, same narration. Pick A, B or tie per question. Answers stay in this page until you export them; nothing is sent anywhere.</p>
<div class="bar"><button id="reveal">Reveal which is which</button><button id="export">Export answers (JSON)</button></div>
<div id="cases"></div>
<script>
const D=${data};
const root=document.getElementById("cases");let revealed=false;
const mk=(t,a,c)=>Object.assign(document.createElement(t),a||{},c?{className:c}:{});
const labels=[];
D.cases.forEach(c=>{
  const box=mk("section",{},"case");box.append(mk("h2",{textContent:c.title}),mk("p",{textContent:c.text}));
  const pair=mk("div",{},"pair");
  ["A","B"].forEach(l=>{const w=mk("div");w.append(mk("strong",{textContent:l}),mk("video",{src:"blind/"+c.id+"/"+l+".mp4",poster:"blind/"+c.id+"/"+l+".png",controls:true,preload:"metadata"}));
    const tag=mk("span",{},"reveal");tag.hidden=true;tag.dataset.case=c.id;tag.dataset.label=l;w.append(tag);pair.append(w)});
  box.append(pair);
  D.questions.forEach((q,i)=>{const f=mk("fieldset");f.append(mk("legend",{textContent:q}));
    [["A","A"],["B","B"],["tie","Tie"]].forEach(([v,t])=>{const l=mk("label");const r=mk("input",{type:"radio",name:c.id+"-"+i,value:v});l.append(r," "+t);f.append(l)});box.append(f)});
  root.append(box)});
const tags=()=>document.querySelectorAll(".reveal");
document.getElementById("reveal").onclick=()=>{revealed=!revealed;tags().forEach(t=>{t.hidden=!revealed;t.textContent=D.order[t.dataset.case][t.dataset.label==="A"?0:1]});
  document.getElementById("reveal").textContent=revealed?"Hide":"Reveal which is which"};
document.getElementById("export").onclick=()=>{
  const out={seed:D.seed,exportedAt:new Date().toISOString(),answers:D.cases.map(c=>({case:c.id,order:D.order[c.id],picks:D.questions.map((q,i)=>{const s=document.querySelector('input[name="'+c.id+'-'+i+'"]:checked');const v=s?s.value:null;return{question:q,pick:v,renderer:v==="A"?D.order[c.id][0]:v==="B"?D.order[c.id][1]:v}})}))};
  const a=mk("a",{href:URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"})),download:"hyperframes-ab-answers.json"});a.click()};
</script></main></body></html>
`;
};

const flag = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const isLoopback = (url: URL): boolean =>
  ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

const probe = async (path: string): Promise<{ frames: number; durationMs: number }> => {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames:format=duration",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams: { nb_read_frames: string }[];
    format: { duration: string };
  };
  return {
    frames: Number(parsed.streams[0]?.nb_read_frames ?? 0),
    durationMs: Math.round(Number(parsed.format.duration) * 1000),
  };
};

const toneClip = async (dir: string, voiceMs: number): Promise<Uint8Array> => {
  const tone = join(dir, "voice.wav");
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=180:duration=${voiceMs / 1000},volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame`,
    "-ar",
    "24000",
    tone,
  ]);
  return new Uint8Array(await readFile(tone));
};

const peakRssMb = (): number => Math.round(process.resourceUsage().maxRSS / 1024);

const measure = async (
  run: () => Promise<{ bytes: Uint8Array; encodeMs: number | null }>,
  file: string,
  fps: number,
): Promise<Metrics> => {
  const started = performance.now();
  try {
    const out = await run();
    const wallMs = Math.round(performance.now() - started);
    await writeFile(file, out.bytes);
    const p = await probe(file);
    return {
      ok: true,
      wallMs,
      frames: p.frames,
      fps,
      durationMs: p.durationMs,
      outputBytes: out.bytes.byteLength,
      encodeMs: out.encodeMs,
      chromeStartupMs: null,
      peakRssMb: peakRssMb(),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "render_failed",
      wallMs: Math.round(performance.now() - started),
      frames: null,
      fps: null,
      durationMs: null,
      outputBytes: null,
      encodeMs: null,
      chromeStartupMs: null,
      peakRssMb: peakRssMb(),
    };
  }
};

/** Hands the SAME input object to both renderers; a failure in one never stops the other. */
export const renderBoth = async (
  input: StickmanMotionRenderInput,
  renderers: Readonly<{
    stickman: Pick<ReturnType<typeof createStickmanMotionRenderer>, "render">;
    hyperframes: Pick<ReturnType<typeof createHyperFramesRenderer>, "render">;
  }>,
  files: Readonly<{ sFile: string; hFile: string }>,
): Promise<{ s: Metrics; h: Metrics }> => {
  const s = await measure(
    async () => {
      const o = await renderers.stickman.render(input);
      return { bytes: o.bytes, encodeMs: o.timings.encodeMs };
    },
    files.sFile,
    input.plan.fps,
  );
  const h = await measure(
    async () => {
      const o = await renderers.hyperframes.render(input);
      return { bytes: o.bytes, encodeMs: o.timings.encodeMs };
    },
    files.hFile,
    input.plan.fps,
  );
  return { s, h };
};

const poster = async (video: string, png: string, atMs: number): Promise<void> => {
  await exec("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-ss",
    String(atMs / 1000),
    "-i",
    video,
    "-frames:v",
    "1",
    png,
  ]);
};

export const runCompare = async (
  seconds: number,
  outDir: string,
  only?: readonly string[],
): Promise<Manifest> => {
  const cases = only?.length ? COMPARE_CASES.filter((c) => only.includes(c.id)) : COMPARE_CASES;
  configureBundledFonts();
  await mkdir(outDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "hf-compare-"));
  const stickman = createStickmanMotionRenderer({ timeoutMs: 600_000 });
  const hyperframes = createHyperFramesRenderer({ timeoutMs: 600_000 });
  const ttsUrl = process.env.TTS_URL ? new URL(process.env.TTS_URL) : undefined;
  if (ttsUrl && !isLoopback(ttsUrl)) throw new Error("hyperframes_compare_tts_loopback_only");
  const kokoro = ttsUrl ? createKokoroSpeechSynthesizer({ baseUrl: ttsUrl.origin }) : undefined;
  const notes = [
    "peakRssMb is the cumulative process.resourceUsage().maxRSS of this node process; ffmpeg and Chrome children are excluded.",
    "hyperframes encodeMs is null: the CLI does not report its encode stage. chromeStartupMs comes from a separate 1.5 s warmup render (CLI + Chrome start upper bound), shared by all cases.",
    "Fixture numbers are illustrative; no case states a product fact.",
  ];
  try {
    const results: CaseResult[] = [];
    for (const c of cases) {
      let voice: CompareVoice | undefined;
      let clip: Uint8Array | undefined;
      if (kokoro) {
        const spoken = await kokoro.synthesize({
          text: c.text,
          voiceId: c.voiceId,
          language: "en-US",
        });
        voice = { durationMs: spoken.durationMs, words: spoken.words };
        clip = spoken.bytes;
      }
      const { plan, voiceStartMs, voiceMs } = buildComparePlan(c, seconds, voice);
      clip ??= await toneClip(work, voiceMs);
      // Both renderers get this exact input object.
      const input: StickmanMotionRenderInput = { plan, voiceClips: [clip], voiceStartMs };
      const dir = join(outDir, "cases", c.id);
      await mkdir(dir, { recursive: true });
      const sFile = join(dir, "stickman.mp4");
      const hFile = join(dir, "hyperframes.mp4");
      const { s, h } = await renderBoth(input, { stickman, hyperframes }, { sFile, hFile });
      const at = Math.round(plan.durationMs * 0.7);
      if (s.ok) await poster(sFile, join(dir, "stickman.png"), at);
      if (h.ok) await poster(hFile, join(dir, "hyperframes.png"), at);
      results.push({
        id: c.id,
        title: c.title,
        text: c.text,
        voiceId: c.voiceId,
        stickman: s,
        hyperframes: h,
      });
      console.error(
        `${c.id}: stickman ${s.ok ? `${s.wallMs}ms` : s.error}, hyperframes ${h.ok ? `${h.wallMs}ms` : h.error}`,
      );
    }
    // Warmup: a minimal render measures CLI + Chrome start (upper bound), reported separately.
    const warm = buildComparePlan(COMPARE_CASES[0] as CompareCase, 1.5);
    const warmClip = await toneClip(work, warm.voiceMs);
    const warmStart = performance.now();
    let chromeStartupMs: number | null = null;
    try {
      await hyperframes.render({
        plan: warm.plan,
        voiceClips: [warmClip],
        voiceStartMs: warm.voiceStartMs,
      });
      chromeStartupMs = Math.round(performance.now() - warmStart);
    } catch {
      chromeStartupMs = null;
    }
    const order = blindOrder(
      "hyperframes-ab-v1",
      cases.map((c) => c.id),
    );
    const summary = (name: RendererName) => {
      const ok = results.map((r) => r[name]).filter((m) => m.ok);
      return {
        okCases: ok.length,
        meanWallMs: ok.length
          ? Math.round(ok.reduce((a, m) => a + (m.wallMs ?? 0), 0) / ok.length)
          : null,
        totalBytes: ok.reduce((a, m) => a + (m.outputBytes ?? 0), 0),
        chromeStartupMs: name === "hyperframes" ? chromeStartupMs : null,
        peakRssMb: peakRssMb(),
      };
    };
    const manifest: Manifest = {
      generatedAt: new Date().toISOString(),
      seconds,
      voice: kokoro ? "kokoro" : "tone",
      hyperframesVersion: HYPERFRAMES_VERSION,
      node: process.version,
      notes,
      order,
      cases: results,
      renderers: { stickman: summary("stickman"), hyperframes: summary("hyperframes") },
    };
    for (const r of results) {
      const [a, b] = order[r.id] as readonly [RendererName, RendererName];
      const blind = join(outDir, "blind", r.id);
      await mkdir(blind, { recursive: true });
      for (const [label, name] of [
        ["A", a],
        ["B", b],
      ] as const) {
        for (const ext of ["mp4", "png"]) {
          const src = join(outDir, "cases", r.id, `${name}.${ext}`);
          const dest = join(blind, `${label}.${ext}`);
          await rm(dest, { force: true });
          await link(src, dest)
            .catch(() => copyFile(src, dest))
            .catch(() => undefined);
        }
      }
    }
    await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(join(outDir, "index.html"), renderIndexHtml(manifest));
    return manifest;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

if (process.argv[1]?.endsWith("render-compare-hyperframes.js")) {
  const seconds = Number(flag("seconds") ?? 6);
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 60) {
    console.error("hyperframes_compare_seconds_invalid");
    process.exit(1);
  }
  void runCompare(
    seconds,
    flag("out") ?? "artifacts/hyperframes-comparison",
    flag("cases")?.split(","),
  )
    .then((m) => console.log(JSON.stringify(m.renderers)))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : "hyperframes compare failed");
      process.exitCode = 1;
    });
}
