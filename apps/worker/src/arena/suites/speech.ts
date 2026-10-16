import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ArenaCandidate, championFor } from "@money-maker/core/arena/catalog";
import type { CandidateResult, CaseResult } from "@money-maker/core/arena/leaderboard";
import { characterErrorRate, wordErrorRate } from "@money-maker/core/arena/text-metrics";
import { VOICE_BENCH_CORPUS_PT_BR } from "@money-maker/core/assets/fixtures/voice-bench-corpus";
import { expandSpokenPtBr } from "@money-maker/core/assets/spoken-text";
import { analyzeWav } from "@money-maker/core/assets/wav-analysis";
import { createAudiocppClient } from "@money-maker/providers/media/audiocpp-client";
import {
  type ArenaEnv,
  downloadFile,
  ensureLinuxBinary,
  type RunningServer,
  startLocalServer,
} from "../runtime.js";
import { casesForStage, mean, okResult, type Suite, type SuiteContext } from "../suite.js";

/**
 * Speech arenas on an audio.cpp server (CPU). TTS QA: every line of the pt-BR corpus is
 * synthesized from its spoken form, checked as a signal (level, clipping, edge silence, speaking
 * rate) and transcribed back by the ASR champion: the character error rate of that round trip is
 * the intelligibility score. Naturalness is not measurable here; the blind human page is for it.
 * ASR QA: word error rate on known speech (the TTS champion's two voices over the same corpus).
 */
const PORT = 18200;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = "candidate";
const REFERENCE_TEXT =
  "Oi, eu sou a voz de referência do Example Shop e hoje vou te mostrar uma coisa boa.";

type AudiocppLaunch = Extract<ArenaCandidate["launch"], { runtime: "audiocpp-server" }>;
const launchOf = (candidate: ArenaCandidate): AudiocppLaunch => {
  if (candidate.launch.runtime !== "audiocpp-server") throw new Error("arena_launch_mismatch");
  return candidate.launch;
};

const fileOf = (env: ArenaEnv, candidate: ArenaCandidate) => {
  const file = candidate.files[0];
  if (!file) throw new Error("arena_files_missing");
  return { path: join(env.modelsDir, file.file), file };
};

/** One audio.cpp server holding the given models (lazy, at most one resident). */
export const startAudiocpp = async (
  env: ArenaEnv,
  models: readonly Readonly<{ id: string; candidate: ArenaCandidate }>[],
): Promise<RunningServer> => {
  const binary = await ensureLinuxBinary(env, "audiocpp");
  const config = {
    host: "127.0.0.1",
    port: PORT,
    backend: "cpu",
    threads: Number(process.env.ARENA_THREADS ?? 8),
    lazy_load: true,
    max_loaded_models: 1,
    models: models.map(({ id, candidate }) => {
      const launch = launchOf(candidate);
      return {
        id,
        family: launch.family,
        path: fileOf(env, candidate).path,
        task: launch.serverTask ?? launch.task,
        mode: "offline",
        ...(launch.load ? { load_options: launch.load, session_options: launch.load } : {}),
      };
    }),
  };
  const path = join(env.binDir, `audiocpp-${PORT}.json`);
  await writeFile(path, JSON.stringify(config, null, 1));
  return startLocalServer(binary, ["--config", path, "--no-ui"], BASE, "/health", 120_000);
};

const ensureCandidateFiles = async (env: ArenaEnv, candidate: ArenaCandidate) => {
  for (const file of candidate.files) await downloadFile(file.url, join(env.modelsDir, file.file));
};

const errorCode = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 80) : "speech_failed";

const corpus = () =>
  VOICE_BENCH_CORPUS_PT_BR.map((c) => ({ ...c, spoken: expandSpokenPtBr(c.text).spoken }));

const voiceRefPath = (outDir: string) => join(outDir, "voice-ref.wav");

export const ttsSuite: Suite = {
  task: "tts.ptbr",
  media: { kind: "audio", ext: "wav" },
  brief: (caseId) => VOICE_BENCH_CORPUS_PT_BR.find((c) => c.id === caseId)?.text ?? caseId,
  async run(context: SuiteContext) {
    const { env, candidate, outDir, dir } = context;
    const launch = launchOf(candidate);
    const server = await startAudiocpp(env, [{ id: MODEL, candidate }]);
    try {
      const client = createAudiocppClient({ baseUrl: server.baseUrl });
      await mkdir(join(outDir, dir), { recursive: true });
      // The champion records the cloning reference that voice-clone challengers start from.
      if (candidate.champion) {
        const ref = await client.speech({
          model: MODEL,
          text: REFERENCE_TEXT,
          options: launch.request,
        });
        await writeFile(voiceRefPath(outDir), ref.wav);
      }
      const reference = launch.voiceReference
        ? await readFile(voiceRefPath(outDir)).then(
            () => ({ voice_ref: voiceRefPath(outDir), reference_text: REFERENCE_TEXT }),
            () => {
              throw new Error("voice_reference_missing");
            },
          )
        : {};
      const cases: CaseResult[] = [];
      const latencies: number[] = [];
      for (const item of casesForStage(corpus(), context.stage)) {
        try {
          const { wav, latencyMs } = await client.speech({
            model: MODEL,
            text: item.spoken,
            options: { ...launch.request, ...reference, seed: 7 },
          });
          const signal = analyzeWav(wav);
          await writeFile(join(outDir, dir, `${item.id}.wav`), wav);
          const speechMs = Math.max(
            1,
            signal.durationMs - signal.leadingSilenceMs - signal.trailingSilenceMs,
          );
          latencies.push(latencyMs);
          cases.push({
            caseId: item.id,
            metrics: {
              failed: 0,
              latencyMs,
              audioMs: signal.durationMs,
              rtf: latencyMs / Math.max(1, signal.durationMs),
              charsPerSecond: item.spoken.length / (speechMs / 1000),
              clippingRatio: signal.clippingRatio,
              peakDbfs: signal.peakDbfs,
              rmsDbfs: signal.rmsDbfs,
              edgeSilenceMs: signal.leadingSilenceMs + signal.trailingSilenceMs,
              sampleRate: signal.sampleRate,
            },
          });
        } catch (error) {
          env.log(
            `  ${item.id}: ${errorCode(error)} ${String((error as { cause?: unknown }).cause ?? "")}`,
          );
          cases.push({ caseId: item.id, metrics: { failed: 1 } });
        }
      }
      return okResult(context, cases, {
        latenciesMs: latencies,
        peakRamMb: await server.peakRamMb(),
      });
    } finally {
      await server.stop();
    }
  },
  /** ASR round trip with the ASR champion: fills cer/wer per case and in the aggregates. */
  async judge(results, { env, outDir, dirs }) {
    const judge = championFor("asr.ptbr");
    if (!judge) return results;
    await ensureCandidateFiles(env, judge);
    const server = await startAudiocpp(env, [{ id: "judge", candidate: judge }]);
    const spoken = new Map(corpus().map((c) => [c.id, c.spoken]));
    try {
      const client = createAudiocppClient({ baseUrl: server.baseUrl });
      const judged: CandidateResult[] = [];
      for (const result of results) {
        const dir = dirs.get(result.id);
        if (result.status !== "ok" || !dir) {
          judged.push(result);
          continue;
        }
        const cases: CaseResult[] = [];
        for (const c of result.cases) {
          const reference = spoken.get(c.caseId);
          if (c.metrics.failed === 1 || !reference) {
            cases.push(c);
            continue;
          }
          const wav = new Uint8Array(await readFile(join(outDir, dir, `${c.caseId}.wav`)));
          const text = await client
            .transcribe({ model: "judge", wav, language: "pt" })
            .then((r) => r.text)
            .catch(() => "");
          cases.push({
            caseId: c.caseId,
            metrics: {
              ...c.metrics,
              cer: Math.min(1, characterErrorRate(reference, text)),
              wer: Math.min(1, wordErrorRate(reference, text)),
            },
          });
          await writeFile(join(outDir, dir, `${c.caseId}.asr.txt`), text);
        }
        judged.push({
          ...result,
          cases,
          aggregate: {
            ...result.aggregate,
            cer: mean(cases.map((c) => c.metrics.cer)),
            wer: mean(cases.map((c) => c.metrics.wer)),
          },
        });
        env.log(`  judged ${result.id}: cer ${mean(cases.map((c) => c.metrics.cer))?.toFixed(3)}`);
      }
      return judged;
    } finally {
      await server.stop();
    }
  },
};

/** Known speech for the ASR arena: the TTS champion's voices over the corpus, made once. */
const asrDataset = async (env: ArenaEnv) => {
  const dir = join(env.modelsDir, "..", "datasets", "asr-ptbr");
  const voices = ["pf_dora", "pm_alex"];
  const items = voices.flatMap((voice) =>
    corpus().map((c) => ({ id: `${voice}-${c.id}`, voice, text: c.text, spoken: c.spoken })),
  );
  const missing = [];
  for (const item of items)
    if (!(await readFile(join(dir, `${item.id}.wav`)).catch(() => null))) missing.push(item);
  if (missing.length) {
    const tts = championFor("tts.ptbr");
    if (!tts) throw new Error("tts_champion_missing");
    await ensureCandidateFiles(env, tts);
    await mkdir(dir, { recursive: true });
    const server = await startAudiocpp(env, [{ id: "tts", candidate: tts }]);
    try {
      const client = createAudiocppClient({ baseUrl: server.baseUrl });
      for (const item of missing) {
        const { wav } = await client.speech({
          model: "tts",
          text: item.spoken,
          options: { ...launchOf(tts).request, voice: item.voice, seed: 7 },
        });
        await writeFile(join(dir, `${item.id}.wav`), wav);
      }
    } finally {
      await server.stop();
    }
  }
  // Interleave voices so a smoke run hears both.
  const ordered = corpus().flatMap((c) =>
    voices.map((voice) => items.find((i) => i.id === `${voice}-${c.id}`)),
  );
  return { dir, items: ordered.filter((i): i is (typeof items)[number] => i !== undefined) };
};

export const asrSuite: Suite = {
  task: "asr.ptbr",
  media: { kind: "text", ext: "txt" },
  async run(context) {
    const { env, candidate, outDir, dir } = context;
    const dataset = await asrDataset(env);
    const server = await startAudiocpp(env, [{ id: MODEL, candidate }]);
    try {
      const client = createAudiocppClient({ baseUrl: server.baseUrl });
      await mkdir(join(outDir, dir), { recursive: true });
      const cases: CaseResult[] = [];
      const latencies: number[] = [];
      for (const item of casesForStage(dataset.items, context.stage)) {
        try {
          const wav = new Uint8Array(await readFile(join(dataset.dir, `${item.id}.wav`)));
          const { text, latencyMs } = await client.transcribe({
            model: MODEL,
            wav,
            language: "pt",
          });
          await writeFile(join(outDir, dir, `${item.id}.txt`), text);
          latencies.push(latencyMs);
          cases.push({
            caseId: item.id,
            metrics: {
              failed: 0,
              wer: Math.min(1, wordErrorRate(item.spoken, text)),
              cer: Math.min(1, characterErrorRate(item.spoken, text)),
              rtf: latencyMs / Math.max(1, analyzeWav(wav).durationMs),
            },
          });
        } catch (error) {
          env.log(`  ${item.id}: ${errorCode(error)}`);
          cases.push({ caseId: item.id, metrics: { failed: 1 } });
        }
      }
      return okResult(context, cases, {
        latenciesMs: latencies,
        peakRamMb: await server.peakRamMb(),
      });
    } finally {
      await server.stop();
    }
  },
};
