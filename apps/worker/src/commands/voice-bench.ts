import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  VOICE_BENCH_CORPUS,
  VOICE_BENCH_CORPUS_PT_BR,
} from "@money-maker/core/assets/fixtures/voice-bench-corpus";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import { expandSpokenPtBr } from "@money-maker/core/assets/spoken-text";
import { expandSpokenEn } from "@money-maker/core/assets/spoken-text-en";
import { wavDurationMs } from "@money-maker/core/assets/wav-duration";
import { createOpenAiSpeechBenchClient } from "@money-maker/providers/media/openai-speech-bench-client";

/**
 * Optional voice challenger benchmark. Evidence for an OWNER voice decision only: it never
 * changes a niche voice, the production SpeechSynthesizer, or Kokoro wiring (`promoted` is false).
 * VoiceStudio (AGPL-3.0) is only ever an external HTTP service here.
 */
export type VoiceCandidate = Readonly<{
  baseUrl: string;
  engine: string;
  model: string;
  voice: string;
  policyModel: string;
  /** Optional engine-specific request fields (e.g. Chatterbox exaggeration, cfg_weight, temperature). */
  extra?: Readonly<Record<string, unknown>>;
}>;

export type VoiceRow = Readonly<{
  engine: string;
  model: string;
  voice: string;
  caseId: string;
  policyModel: string;
  policyEnabled: boolean | null;
  latencyMs: number | null;
  audioMs: number | null;
  sampleRate: number | null;
  channels: number | null;
  bytes: number | null;
  decodeValid: boolean;
  error: string | null;
  humanScore: null;
}>;

export type VoiceBenchOptions = Readonly<{
  lang?: "en-US" | "pt-BR";
  timeoutMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
  onWav?: (candidateIndex: number, caseId: string, bytes: Uint8Array) => Promise<void>;
}>;

const errorCode = (error: unknown): string =>
  error instanceof Error && /^[a-z0-9_]+$/u.test(error.message) ? error.message : "speech_failed";

export const readVoiceBenchCandidates = (env: NodeJS.ProcessEnv): readonly VoiceCandidate[] => {
  const raw = env.VOICE_BENCH_CANDIDATES;
  if (!raw) throw new Error("voice_bench_candidates_missing");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("voice_bench_candidates_invalid");
  return parsed.map((item: Record<string, unknown>) => {
    for (const key of ["baseUrl", "engine", "model", "voice", "policyModel"])
      if (typeof item[key] !== "string" || item[key] === "")
        throw new Error("voice_bench_candidates_invalid");
    const { extra } = item;
    if (
      extra !== undefined &&
      (typeof extra !== "object" || extra === null || Array.isArray(extra))
    )
      throw new Error("voice_bench_candidates_invalid");
    return item as unknown as VoiceCandidate;
  });
};

/** Header fields the core duration helper does not return. Standard `fmt ` chunk right after WAVE. */
const wavFormat = (b: Uint8Array): { sampleRate: number; channels: number } => {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { channels: v.getUint16(22, true), sampleRate: v.getUint32(24, true) };
};

const blank = (c: VoiceCandidate, caseId: string): VoiceRow => ({
  engine: c.engine,
  model: c.model,
  voice: c.voice,
  caseId,
  policyModel: c.policyModel,
  policyEnabled: modelPolicyFor(c.policyModel)?.enabled ?? null,
  latencyMs: null,
  audioMs: null,
  sampleRate: null,
  channels: null,
  bytes: null,
  decodeValid: false,
  error: null,
  humanScore: null,
});

export const runVoiceBench = async (
  candidates: readonly VoiceCandidate[],
  options: VoiceBenchOptions = {},
): Promise<readonly VoiceRow[]> => {
  const rows: VoiceRow[] = [];
  const ptBR = options.lang === "pt-BR";
  const corpus = ptBR ? VOICE_BENCH_CORPUS_PT_BR : VOICE_BENCH_CORPUS;
  for (const [index, candidate] of candidates.entries()) {
    const policy = modelPolicyFor(candidate.policyModel);
    const refusal =
      !policy || policy.capability !== "tts" || policy.licensePolicy !== "commercial_allowed"
        ? "model_license_not_allowed"
        : null;
    let client: ReturnType<typeof createOpenAiSpeechBenchClient> | null = null;
    let setupError = refusal;
    if (!refusal) {
      try {
        client = createOpenAiSpeechBenchClient({
          baseUrl: candidate.baseUrl,
          timeoutMs: options.timeoutMs ?? 120_000,
          maxBytes: options.maxBytes ?? 50_000_000,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      } catch (error) {
        setupError = errorCode(error);
      }
    }
    for (const item of corpus) {
      const base = blank(candidate, item.id);
      if (!client) {
        rows.push({ ...base, error: setupError });
        continue;
      }
      // Same spoken-form step production applies to narration before Kokoro.
      const text = (ptBR ? expandSpokenPtBr(item.text) : expandSpokenEn(item.text)).spoken;
      const started = performance.now();
      try {
        const audio = await client.synthesize({
          model: candidate.model,
          voice: candidate.voice,
          text,
          ...(candidate.extra ? { extra: candidate.extra } : {}),
        });
        const latencyMs = Math.round(performance.now() - started);
        let audioMs: number | null = null;
        try {
          audioMs = wavDurationMs(audio.bytes);
        } catch {
          // decodeValid stays false
        }
        const format = audioMs === null ? null : wavFormat(audio.bytes);
        rows.push({
          ...base,
          latencyMs,
          audioMs,
          sampleRate: format?.sampleRate ?? null,
          channels: format?.channels ?? null,
          bytes: audio.bytes.byteLength,
          decodeValid: audioMs !== null && audioMs > 0,
          error: audioMs === null ? "speech_audio_invalid" : null,
        });
        if (audioMs !== null)
          await options.onWav?.(index, item.id, audio.bytes).catch(() => undefined);
      } catch (error) {
        rows.push({
          ...base,
          latencyMs: Math.round(performance.now() - started),
          error: errorCode(error),
        });
      }
    }
  }
  return rows;
};

const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null);

export const summarizeVoiceBench = (rows: readonly VoiceRow[]) => {
  const keys = [...new Set(rows.map((r) => `${r.engine}\u0000${r.model}\u0000${r.voice}`))];
  return {
    promoted: false as const,
    note: "Latency is wall time over HTTP (first request may include model load). Scores are human; no niche voice is changed.",
    candidates: keys.map((key) => {
      const own = rows.filter((r) => `${r.engine}\u0000${r.model}\u0000${r.voice}` === key);
      const ok = own.filter((r) => r.error === null && r.latencyMs !== null && r.audioMs);
      const latencies = ok.map((r) => r.latencyMs as number).sort((a, b) => a - b);
      const rtfs = ok.map((r) => (r.latencyMs as number) / (r.audioMs as number));
      const first = own[0];
      return {
        engine: first?.engine,
        model: first?.model,
        voice: first?.voice,
        policyModel: first?.policyModel,
        policyEnabled: first?.policyEnabled ?? null,
        rows: own.length,
        failures: own.filter((r) => r.error !== null).length,
        errors: [...new Set(own.map((r) => r.error).filter((e) => e !== null))],
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        rtfP50: percentile(
          [...rtfs].sort((a, b) => a - b),
          0.5,
        ),
        promoted: false as const,
      };
    }),
  };
};

/** Small deterministic PRNG (mulberry32) so a blind order is reproducible from its seed. */
export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const esc = (s: string): string =>
  s.replace(/[&<>"]/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Blind listening pack: labels hidden until Reveal, 1-5 scores, JSON download, no network. */
export const buildListeningPage = (
  candidates: readonly VoiceCandidate[],
  rows: readonly VoiceRow[],
  seed: number,
  corpus: readonly { id: string; text: string }[] = VOICE_BENCH_CORPUS,
): string => {
  const rand = mulberry32(seed);
  const cases = corpus.map((item) => {
    const available = candidates
      .map((c, index) => ({ c, index }))
      .filter(({ index }) =>
        rows.some((r) => r.caseId === item.id && r.error === null && rowIs(r, candidates[index])),
      );
    for (let i = available.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [available[i], available[j]] = [available[j] as never, available[i] as never];
    }
    return { id: item.id, text: item.text, entries: available };
  });
  const body = cases
    .map(
      (c) =>
        `<section><h2>${esc(c.id)}</h2><p>${esc(c.text)}</p>${c.entries
          .map(
            ({ c: cand, index }, n) =>
              `<div class="e" data-case="${esc(c.id)}" data-label="${esc(`${cand.engine} / ${cand.model} / ${cand.voice}`)}"><b>${String.fromCharCode(65 + n)}</b> <audio controls preload="none" src="${index}-${esc(c.id)}.wav"></audio> <label>score <input type="number" min="1" max="5" step="1"></label> <span class="r" hidden></span></div>`,
          )
          .join("")}</section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Voice bench</title><style>body{font:16px system-ui;max-width:48rem;margin:1rem auto;padding:0 1rem}section{border-top:1px solid #ccc;padding:.5rem 0}.e{margin:.4rem 0}input{width:3rem}</style><h1>Blind listening (seed ${seed})</h1><p>Score 1-5 per clip, then Reveal and Download. Local only.</p>${body}<p><button id="reveal">Reveal labels</button> <button id="dl">Download scores JSON</button></p><script>
const q=(s)=>[...document.querySelectorAll(s)];
document.getElementById("reveal").onclick=()=>q(".e").forEach(e=>{const r=e.querySelector(".r");r.textContent=e.dataset.label;r.hidden=false});
document.getElementById("dl").onclick=()=>{const out=q(".e").map(e=>({caseId:e.dataset.case,label:e.dataset.label,humanScore:e.querySelector("input").value?Number(e.querySelector("input").value):null}));const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:"application/json"}));a.download="voice-scores.json";a.click()};
</script></html>`;
};

const rowIs = (r: VoiceRow, c: VoiceCandidate | undefined): boolean =>
  !!c && r.engine === c.engine && r.model === c.model && r.voice === c.voice;

const main = async (): Promise<void> => {
  const candidates = readVoiceBenchCandidates(process.env);
  const outDir = resolve("voice-bench-out", new Date().toISOString().replace(/[:.]/gu, "-"));
  await mkdir(outDir, { recursive: true });
  const lines: string[] = [];
  const lang =
    (process.argv.find((a) => a.startsWith("--lang="))?.slice(7) ??
      process.env.VOICE_BENCH_LANG) === "pt-BR"
      ? "pt-BR"
      : "en-US";
  const rows = await runVoiceBench(candidates, {
    lang,
    onWav: (index, caseId, bytes) => writeFile(join(outDir, `${index}-${caseId}.wav`), bytes),
  });
  for (const r of rows) lines.push(JSON.stringify(r));
  await writeFile(join(outDir, "rows.jsonl"), `${lines.join("\n")}\n`);
  const summary = summarizeVoiceBench(rows);
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(
    join(outDir, "index.html"),
    buildListeningPage(
      candidates,
      rows,
      Math.floor(Date.now() / 1000) % 100_000,
      lang === "pt-BR" ? VOICE_BENCH_CORPUS_PT_BR : VOICE_BENCH_CORPUS,
    ),
  );
  console.info(JSON.stringify({ outDir, ...summary }, null, 2));
};

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(errorCode(error));
    process.exitCode = 1;
  });
}
