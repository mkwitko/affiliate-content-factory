import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { championFor, profileIdOf } from "@money-maker/core/arena/catalog";
import type { CandidateResult, CaseResult } from "@money-maker/core/arena/leaderboard";
import {
  headToHead,
  type PairwiseJudgment,
  reconcileJudgments,
} from "@money-maker/core/arena/ranking";
import { realProductsInterleaved, sceneCaseFromReal } from "@money-maker/core/arena/real-dataset";
import { isLocalClipProfile, localClipProfile } from "@money-maker/core/assets/local-clip-profile";
import {
  EDIT_BENCH_CORPUS,
  EDIT_BENCH_PRODUCT_TITLES,
  type EditBenchCase,
} from "@money-maker/core/creatives/fixtures/edit-bench-corpus";
import { type ScenePlan, scenePrompt } from "@money-maker/core/creatives/scene-plan";
import { fitImage, lumaStdev, reencodeImage } from "@money-maker/providers/http/fit-image";
import { createLlamaServerFidelityVlm } from "@money-maker/providers/llm/llama-server-fidelity-vlm";
import { meanFrameDiff, probeVideo } from "@money-maker/providers/media/clip-video";
import { imageDegeneracy } from "@money-maker/providers/media/image-sanity";
import {
  createSdCppImageEditor,
  createSdCppSceneGenerator,
} from "@money-maker/providers/media/sdcpp-scene-generator";
import { createSdCppVideoGenerator } from "@money-maker/providers/media/sdcpp-video-generator";
import { colourEvidence } from "@money-maker/providers/media/sharp-colour-evidence";
import { loadReference, runEditBench } from "../../commands/edit-bench.js";
import { buildPairs, FIDELITY_CASES, runFidelityBench } from "../../commands/fidelity-bench.js";
import type { ArenaEnv } from "../runtime.js";
import { startLlama, startSd } from "../servers.js";
import { casesForStage, mean, okResult, type Suite, type SuiteContext } from "../suite.js";
import { readImage, scenesDir, startVlmJudge } from "../vlm-judge.js";

const execFileAsync = promisify(execFile);
const errorCode = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 80) : "failed";
const REF_BASE =
  process.env.EDIT_BENCH_REF_BASE ??
  "https://mcp.example.com/v1/public/workspaces/WORKSPACE_ID/assets/";
const refFile = (env: ArenaEnv, assetId: string) => join(scenesDir(env), "refs", `${assetId}.bin`);
const ensureRef = (env: ArenaEnv, assetId: string) =>
  loadReference(REF_BASE, assetId, join(scenesDir(env), "refs"));

/**
 * A reference is a public asset id, `asset:<id>` or an https listing photo (real products). URLs
 * are cached by hash next to the asset cache and must decode as an image.
 */
export const loadRefFor = async (env: ArenaEnv, ref: string): Promise<Uint8Array> => {
  if (!/^https:\/\//.test(ref)) return ensureRef(env, ref.replace(/^asset:/, ""));
  const file = join(scenesDir(env), "refs", `${createHash("sha1").update(ref).digest("hex")}.bin`);
  const cached = await readFile(file).catch(() => null);
  if (cached) return new Uint8Array(cached);
  const response = await fetch(ref, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("reference_download_failed");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 10_000_000 || !(await reencodeImage(bytes).catch(() => null)))
    throw new Error("reference_invalid");
  await mkdir(join(scenesDir(env), "refs"), { recursive: true });
  await writeFile(file, bytes);
  return bytes;
};
export const refImage = async (env: ArenaEnv, ref: string) => {
  const bytes = await loadRefFor(env, ref);
  return { bytes, mimeType: (await fitImage(bytes)).mimeType };
};

/** Scene case by id from the dataset in use (fixed corpus or real products). */
const sceneCase = (env: ArenaEnv, caseId: string) => {
  if (env.dataset === "real") {
    const real = realProductsInterleaved().find((p) => p.id === caseId);
    if (!real) return null;
    const c = sceneCaseFromReal(real);
    return {
      prompt: c.prompt,
      productRef: c.references[1],
      characterRef: c.references[0],
      title: real.title,
    };
  }
  const c = EDIT_BENCH_CORPUS.find((item) => item.id === caseId);
  return c
    ? {
        prompt: c.prompt,
        productRef: c.references[1],
        characterRef: c.references[0],
        title: EDIT_BENCH_PRODUCT_TITLES[c.references[1]] ?? "",
      }
    : null;
};

/** Interleaved niches so small stages still cover casa, beleza and tech. */
const ORDER = ["casa_feed", "beleza_feed", "tech_feed", "casa_story", "beleza_story", "tech_story"];
const orderedEditCases = (): readonly EditBenchCase[] => [
  ...ORDER.flatMap((id) => EDIT_BENCH_CORPUS.filter((c) => c.id === id)),
  ...EDIT_BENCH_CORPUS.filter((c) => !ORDER.includes(c.id)),
];
/** The desktop renders at 2/3 size (512x640, 512x896) and upscales later. */
const scaled = (c: EditBenchCase): EditBenchCase => {
  const align = (n: number) => Math.max(512, Math.round((n * 0.667) / 64) * 64);
  return { ...c, width: align(c.width), height: align(c.height) };
};

// ---------------------------------------------------------------------------------------------
// vision.product_verification: does the VLM accept the right product and block a swapped one?

export const visionSuite: Suite = {
  task: "vision.product_verification",
  media: { kind: "text", ext: "json" },
  async run(context) {
    const { env, candidate, stage } = context;
    const dir = scenesDir(env);
    const cases = casesForStage(
      ORDER.flatMap((id) => FIDELITY_CASES.filter((c) => c.id === id)),
      stage,
      { smoke: 3, qualification: 6 },
    );
    for (const c of cases) await readFile(join(dir, "images", `${c.id}.png`)); // scenes_missing early
    const server = await startLlama(env, candidate);
    try {
      const vlm = createLlamaServerFidelityVlm({
        baseUrl: server.baseUrl,
        model: profileIdOf(candidate.id),
      });
      const rows = await runFidelityBench({
        pairs: buildPairs(cases),
        loadScene: (caseId) => readImage(join(dir, "images", `${caseId}.png`)),
        loadReference: async (assetId) => {
          await ensureRef(env, assetId);
          return readImage(refFile(env, assetId));
        },
        compare: (args) => vlm.compare(args),
        colour: colourEvidence,
      });
      const results: CaseResult[] = rows.map((row) => ({
        caseId: row.pairId,
        metrics: {
          failed: row.error ? 1 : 0,
          correct:
            row.kind === "positive"
              ? Number(row.verdict === "pass")
              : Number(row.verdict === "block"),
          // Same value under the primary key, so the per-case comparison with the champion works.
          accuracy:
            row.kind === "positive"
              ? Number(row.verdict === "pass")
              : Number(row.verdict === "block"),
          falseAccept: row.kind === "negative" ? Number(row.verdict === "pass") : null,
          falseReject: row.kind === "positive" ? Number(row.verdict !== "pass") : null,
          parsed: Number(row.parsed),
        },
      }));
      return okResult(context, results, {
        latenciesMs: rows.flatMap((r) => (r.latencyMs === null ? [] : [r.latencyMs])),
        peakRamMb: await server.peakRamMb(),
        aggregate: {
          accuracy: mean(results.map((r) => r.metrics.correct)),
          falseAcceptRate: mean(results.map((r) => r.metrics.falseAccept)) ?? 0,
          falseRejectRate: mean(results.map((r) => r.metrics.falseReject)) ?? 0,
          parseFailureRate: 1 - (mean(results.map((r) => r.metrics.parsed)) ?? 0),
        },
      });
    } finally {
      await server.stop();
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Shared judge step: product fidelity per image and blind pairwise against the champion.

const judgeImages = async (
  results: readonly CandidateResult[],
  ctx: Readonly<{ env: ArenaEnv; outDir: string; dirs: ReadonlyMap<string, string> }>,
  options: Readonly<{
    ext: "png";
    championId: string | undefined;
    brief: (caseId: string) => string;
    product?: (
      caseId: string,
    ) => Readonly<{ productRef: string; title: string; characterRef?: string }> | null;
    plate?: true;
  }>,
): Promise<readonly CandidateResult[]> => {
  const judge = await startVlmJudge(ctx.env);
  const file = (id: string, caseId: string) =>
    join(ctx.outDir, ctx.dirs.get(id) ?? "", `${caseId}.${options.ext}`);
  try {
    const judgments: PairwiseJudgment[] = [];
    const out: CandidateResult[] = [];
    for (const result of results) {
      if (result.status !== "ok") {
        out.push(result);
        continue;
      }
      const cases: CaseResult[] = [];
      for (const c of result.cases) {
        if (c.metrics.valid !== 1) {
          cases.push(c);
          continue;
        }
        const image = await readImage(file(result.id, c.caseId));
        const metrics: Record<string, number | null> = { ...c.metrics };
        const product = options.product?.(c.caseId);
        if (product) {
          metrics.productFidelity = await judge.productFidelity(
            image,
            await refImage(ctx.env, product.productRef),
            product.title,
          );
        }
        if (options.plate) {
          const clean = await judge.plate(image);
          metrics.cleanPlate = clean === null ? null : Number(clean);
        }
        if (options.championId && result.id !== options.championId) {
          const champion = await readImage(file(options.championId, c.caseId)).catch(() => null);
          if (champion) {
            const references = product
              ? [
                  ...(product.characterRef
                    ? [
                        {
                          kind: "character" as const,
                          image: await refImage(ctx.env, product.characterRef),
                        },
                      ]
                    : []),
                  {
                    kind: "product" as const,
                    image: await refImage(ctx.env, product.productRef),
                  },
                ]
              : [];
            const pair = await judge.pairwise({
              caseId: c.caseId,
              brief: options.brief(c.caseId),
              references,
              left: { id: options.championId, image: champion },
              right: { id: result.id, image },
            });
            judgments.push(...pair);
            const overall = headToHead(
              reconcileJudgments(pair.filter((j) => !j.caseId.includes("#"))),
              result.id,
              options.championId,
            );
            metrics.pairwiseWin = overall.winRate;
          }
        }
        cases.push({ caseId: c.caseId, metrics });
      }
      out.push({
        ...result,
        cases,
        aggregate: {
          ...result.aggregate,
          productFidelity: mean(cases.map((c) => c.metrics.productFidelity)),
          cleanPlate: mean(cases.map((c) => c.metrics.cleanPlate)),
          pairwiseWinRate: mean(cases.map((c) => c.metrics.pairwiseWin)),
        },
      });
      ctx.env.log(`  judged ${result.id}`);
    }
    if (judgments.length)
      await appendFile(
        join(ctx.outDir, "judgments-vlm.jsonl"),
        judgments.map((j) => `${JSON.stringify(j)}\n`).join(""),
      );
    return out;
  } finally {
    await judge.stop();
  }
};

// ---------------------------------------------------------------------------------------------
// image.character_product: the recurring character with the REAL product, from references.

const editCase = (caseId: string) => EDIT_BENCH_CORPUS.find((c) => c.id === caseId);

export const imageEditSuite: Suite = {
  task: "image.character_product",
  media: { kind: "image", ext: "png" },
  brief: (caseId) => {
    const real = realProductsInterleaved().find((p) => p.id === caseId);
    return real ? sceneCaseFromReal(real).prompt : (editCase(caseId)?.prompt ?? caseId);
  },
  async run(context: SuiteContext) {
    const { env, candidate, outDir, dir, stage } = context;
    const launch = candidate.launch;
    if (launch.runtime !== "sd-server") throw new Error("arena_launch_mismatch");
    const server = await startSd(env, candidate);
    try {
      await mkdir(join(outDir, dir), { recursive: true });
      const model = profileIdOf(candidate.id);
      const rows = await runEditBench({
        model,
        steps: launch.steps,
        cases:
          env.dataset === "real"
            ? casesForStage(realProductsInterleaved().map(sceneCaseFromReal), stage, {
                smoke: 3,
                qualification: 9,
              })
            : casesForStage(orderedEditCases(), stage, { smoke: 3, qualification: 6 }).map(scaled),
        editor: createSdCppImageEditor({
          baseUrl: server.baseUrl,
          model,
          steps: launch.steps,
          referenceMaxSide: 512,
          timeoutMs: 1_800_000,
          arena: true,
        }),
        loadReference: (ref) => loadRefFor(env, ref),
        onImage: (name, bytes) => writeFile(join(outDir, dir, name), bytes),
      });
      const cases: CaseResult[] = [];
      for (const row of rows) {
        const caseId = row.caseId ?? "unknown";
        const bytes = await readFile(join(outDir, dir, `${caseId}.png`)).catch(() => null);
        const degenerate = bytes ? await imageDegeneracy(new Uint8Array(bytes)) : null;
        if (degenerate) env.log(`  ${caseId}: ${degenerate} image`);
        cases.push({
          caseId,
          metrics: {
            failed: row.error ? 1 : 0,
            valid: Number(row.decodeValid && row.dimensionsValid && !degenerate),
            degenerate: degenerate ? 1 : 0,
            latencyMs: row.wallMs,
          },
        });
      }
      const caseErrors = [
        ...new Set(
          rows.flatMap((r) => (r.error ? [`${r.error}${r.detail ? `: ${r.detail}` : ""}`] : [])),
        ),
      ];
      return okResult(context, cases, {
        latenciesMs: rows.flatMap((r) => (r.error === null && r.wallMs !== null ? [r.wallMs] : [])),
        aggregate: { validRate: mean(cases.map((c) => c.metrics.valid)) },
        caseErrors,
      });
    } finally {
      await server.stop();
    }
  },
  judge: (results, ctx) =>
    judgeImages(results, ctx, {
      ext: "png",
      championId: championFor("image.character_product")?.id,
      brief: (caseId) => sceneCase(ctx.env, caseId)?.prompt ?? caseId,
      product: (caseId) => sceneCase(ctx.env, caseId),
    }),
};

// ---------------------------------------------------------------------------------------------
// image.scene_plate: empty backgrounds from the production plate prompt.

const PLATES: readonly Readonly<{ id: string; plan: ScenePlan }>[] = [
  {
    id: "casa_counter",
    plan: {
      role: "hero",
      productAnchor: "center",
      surface: "counter",
      lighting: "top-left",
      nicheSetting: "small bathroom in a rented apartment",
      paletteHint: "sage green, beige and warm white",
    },
  },
  {
    id: "beleza_table",
    plan: {
      role: "hero",
      productAnchor: "left",
      surface: "table",
      lighting: "soft-front",
      nicheSetting: "tiny shared bathroom",
      paletteHint: "sand pink, off-white and gold",
    },
  },
  {
    id: "tech_table",
    plan: {
      role: "hero",
      productAnchor: "right",
      surface: "table",
      lighting: "top-right",
      nicheSetting: "home office desk",
      paletteHint: "graphite, blue-grey and cyan",
    },
  },
  {
    id: "casa_shelf",
    plan: {
      role: "secondary",
      productAnchor: "right",
      surface: "shelf",
      lighting: "soft-front",
      nicheSetting: "laundry corner",
      paletteHint: "sage green and warm white",
    },
  },
  {
    id: "beleza_counter",
    plan: {
      role: "secondary",
      productAnchor: "center",
      surface: "counter",
      lighting: "top-left",
      nicheSetting: "bedroom vanity",
      paletteHint: "sand pink and gold",
    },
  },
  {
    id: "tech_abstract",
    plan: {
      role: "secondary",
      productAnchor: "left",
      surface: "abstract",
      lighting: "top-right",
      nicheSetting: "studio backdrop",
      paletteHint: "graphite and cyan",
    },
  },
];
const SEEDS = { smoke: [11], qualification: [11, 22], full: [11, 22, 33] } as const;

export const plateSuite: Suite = {
  task: "image.scene_plate",
  media: { kind: "image", ext: "png" },
  brief: (caseId) =>
    scenePrompt(
      PLATES.find((p) => caseId.startsWith(p.id))?.plan ??
        (PLATES[0] as (typeof PLATES)[number]).plan,
    ),
  async run(context) {
    const { env, candidate, outDir, dir, stage } = context;
    const launch = candidate.launch;
    if (launch.runtime !== "sd-server") throw new Error("arena_launch_mismatch");
    const server = await startSd(env, candidate);
    try {
      await mkdir(join(outDir, dir), { recursive: true });
      const generator = createSdCppSceneGenerator({
        baseUrl: server.baseUrl,
        model: profileIdOf(candidate.id),
        steps: launch.steps,
        timeoutMs: 1_800_000,
        arena: true,
      });
      const cases: CaseResult[] = [];
      const latencies: number[] = [];
      for (const plate of casesForStage(PLATES, stage, { smoke: 3, qualification: 6 }))
        for (const seed of SEEDS[stage]) {
          const caseId = `${plate.id}_${seed}`;
          const started = performance.now();
          try {
            const image = await generator.generate(
              scenePrompt(plate.plan),
              { width: 512, height: 896 },
              { seed },
            );
            const ms = Math.round(performance.now() - started);
            const decoded = await reencodeImage(image.bytes).catch(() => null);
            await writeFile(join(outDir, dir, `${caseId}.png`), image.bytes);
            latencies.push(ms);
            cases.push({
              caseId,
              metrics: {
                failed: 0,
                valid: Number(
                  decoded?.width === 512 &&
                    decoded?.height === 896 &&
                    !(await imageDegeneracy(image.bytes)),
                ),
                lumaStdev: decoded ? await lumaStdev(image.bytes).catch(() => null) : null,
                latencyMs: ms,
              },
            });
          } catch (error) {
            env.log(`  ${caseId}: ${errorCode(error)}`);
            cases.push({ caseId, metrics: { failed: 1, valid: 0 } });
          }
        }
      return okResult(context, cases, {
        latenciesMs: latencies,
        aggregate: { validRate: mean(cases.map((c) => c.metrics.valid)) },
      });
    } finally {
      await server.stop();
    }
  },
  judge: (results, ctx) =>
    judgeImages(results, ctx, {
      ext: "png",
      championId: championFor("image.scene_plate")?.id,
      brief: (caseId) => plateSuite.brief?.(caseId) ?? caseId,
      plate: true,
    }),
};

// ---------------------------------------------------------------------------------------------
// upscale.illustration: halve an approved scene, upscale it back, compare with the original.

const ffmpegQuality = async (candidate: string, reference: string) => {
  const { stderr } = await execFileAsync(
    "ffmpeg",
    [
      "-hide_banner",
      "-i",
      candidate,
      "-i",
      reference,
      "-lavfi",
      "[0:v][1:v]ssim;[0:v][1:v]psnr",
      "-f",
      "null",
      "-",
    ],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  const ssim = /SSIM .*All:([\d.]+)/.exec(stderr)?.[1];
  const psnr = /PSNR .*average:([\d.]+|inf)/.exec(stderr)?.[1];
  return { ssim: ssim ? Number(ssim) : null, psnr: psnr && psnr !== "inf" ? Number(psnr) : null };
};

const findExe = async (root: string, name: string) => {
  const { stdout } = await execFileAsync("find", [root, "-name", name, "-type", "f"]).catch(() => ({
    stdout: "",
  }));
  const found = stdout.split("\n").find(Boolean);
  if (!found) throw new Error(`runtime_start_failed`);
  return found;
};

export const upscaleSuite: Suite = {
  task: "upscale.illustration",
  media: { kind: "image", ext: "png" },
  brief: () => "2x upscale of a halved approved scene; compare sharpness, halos and line quality",
  async run(context) {
    const { env, candidate, outDir, dir, stage } = context;
    const launch = candidate.launch;
    if (launch.runtime !== "realesrgan-ncnn" && launch.runtime !== "realcugan-ncnn")
      throw new Error("arena_launch_mismatch");
    if (env.target !== "desktop_amd") throw new Error("upscale_needs_desktop");
    const sharp = (await import("sharp")).default;
    const exe =
      launch.runtime === "realesrgan-ncnn"
        ? await findExe("/mnt/e/ai/realesrgan", "realesrgan-ncnn-vulkan.exe")
        : await findExe("/mnt/e/ai/realcugan", "realcugan-ncnn-vulkan.exe");
    const win = async (path: string) =>
      (await execFileAsync("wslpath", ["-w", path])).stdout.trim();
    const sources = casesForStage(ORDER, stage, { smoke: 3, qualification: 6 });
    await mkdir(join(outDir, dir, "work"), { recursive: true });
    const cases: CaseResult[] = [];
    const latencies: number[] = [];
    for (const caseId of sources) {
      const original = join(scenesDir(env), "images", `${caseId}.png`);
      const small = join(outDir, dir, "work", `${caseId}.half.png`);
      const raw = join(outDir, dir, "work", `${caseId}.up.png`);
      const final = join(outDir, dir, `${caseId}.png`);
      try {
        const meta = await sharp(original).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;
        await sharp(original)
          .resize(Math.round(width / 2), Math.round(height / 2), { kernel: "lanczos3" })
          .png()
          .toFile(small);
        const args =
          launch.runtime === "realesrgan-ncnn"
            ? ["-n", launch.modelName, "-s", String(launch.scale), "-f", "png"]
            : ["-n", String(launch.noise), "-s", String(launch.scale), "-f", "png"];
        const started = performance.now();
        // The ncnn tools look for their "models" folder next to the working directory.
        await execFileAsync(exe, ["-i", await win(small), "-o", await win(raw), ...args], {
          timeout: 600_000,
          cwd: dirname(exe),
        });
        const ms = Math.round(performance.now() - started);
        await sharp(raw).resize(width, height, { kernel: "lanczos3" }).png().toFile(final);
        const quality = await ffmpegQuality(final, original);
        latencies.push(ms);
        cases.push({
          caseId,
          metrics: { failed: 0, valid: 1, ssim: quality.ssim, psnr: quality.psnr, latencyMs: ms },
        });
      } catch (error) {
        env.log(`  ${caseId}: ${errorCode(error)}`);
        cases.push({ caseId, metrics: { failed: 1, valid: 0 } });
      }
    }
    return okResult(context, cases, {
      latenciesMs: latencies,
      aggregate: { validRate: mean(cases.map((c) => c.metrics.valid)) },
    });
  },
};

// ---------------------------------------------------------------------------------------------
// video.i2v: a 2 s clip from an approved scene; the product must survive the motion.

const MOTION =
  "gentle natural motion, the person moves slightly, slow camera push-in, steady light";
const NEGATIVE = "readable text, logos, watermarks, deformed hands, melting objects, flicker";

export const videoSuite: Suite = {
  task: "video.i2v",
  media: { kind: "video", ext: "mp4" },
  brief: (caseId) => `${MOTION} (${caseId})`,
  async run(context) {
    const { env, candidate, outDir, dir, stage } = context;
    const launch = candidate.launch;
    if (launch.runtime !== "sd-server") throw new Error("arena_launch_mismatch");
    const server = await startSd(env, candidate);
    try {
      await mkdir(join(outDir, dir), { recursive: true });
      const generator = createSdCppVideoGenerator({
        baseUrl: server.baseUrl,
        model: profileIdOf(candidate.id),
        timeoutMs: 3_600_000,
        allowDisabled: true,
      });
      const profile = localClipProfile({ canvas: "portrait", seconds: 2, steps: launch.steps });
      if (!profile || !isLocalClipProfile(profile)) throw new Error("clip_profile_invalid");
      const cases: CaseResult[] = [];
      const latencies: number[] = [];
      const errors: string[] = [];
      for (const caseId of casesForStage(ORDER, stage, { smoke: 2, qualification: 4 })) {
        const started = performance.now();
        try {
          const reference = new Uint8Array(
            await readFile(join(scenesDir(env), "images", `${caseId}.png`)),
          );
          const clip = await generator.generate({
            prompt: MOTION,
            negativePrompt: NEGATIVE,
            reference,
            profile,
            seed: 1,
          });
          const ms = Math.round(performance.now() - started);
          await writeFile(join(outDir, dir, `${caseId}.mp4`), clip.bytes);
          const probe = await probeVideo(clip.bytes, clip.mimeType).catch(() => null);
          latencies.push(ms);
          cases.push({
            caseId,
            metrics: {
              failed: 0,
              valid: Number(Boolean(probe?.readable && probe.hasVideo && probe.decodeErrors === 0)),
              frames: probe?.frameCount ?? null,
              meanFrameDiff: await meanFrameDiff(clip.bytes, clip.mimeType).catch(() => null),
              latencyMs: ms,
            },
          });
        } catch (error) {
          const cause = (error as { cause?: unknown }).cause;
          errors.push(
            `${errorCode(error)}${typeof cause === "string" ? `: ${cause.slice(0, 120)}` : ""}`,
          );
          env.log(`  ${caseId}: ${errors.at(-1)}`);
          cases.push({ caseId, metrics: { failed: 1, valid: 0 } });
        }
      }
      return okResult(context, cases, {
        latenciesMs: latencies,
        aggregate: { validRate: mean(cases.map((c) => c.metrics.valid)) },
        caseErrors: [...new Set(errors)],
      });
    } finally {
      await server.stop();
    }
  },
  /** Product fidelity on the clip's last frame against the listing photo. */
  async judge(results, ctx) {
    const judge = await startVlmJudge(ctx.env);
    try {
      const out: CandidateResult[] = [];
      for (const result of results) {
        if (result.status !== "ok") {
          out.push(result);
          continue;
        }
        const cases: CaseResult[] = [];
        for (const c of result.cases) {
          const scene = sceneCase(ctx.env, c.caseId);
          if (c.metrics.valid !== 1 || !scene) {
            cases.push(c);
            continue;
          }
          const clip = join(ctx.outDir, ctx.dirs.get(result.id) ?? "", `${c.caseId}.mp4`);
          const frame = `${clip}.last.png`;
          await execFileAsync("ffmpeg", [
            "-y",
            "-hide_banner",
            "-sseof",
            "-0.1",
            "-i",
            clip,
            "-frames:v",
            "1",
            frame,
          ]);
          cases.push({
            caseId: c.caseId,
            metrics: {
              ...c.metrics,
              productFidelity: await judge.productFidelity(
                await readImage(frame),
                await refImage(ctx.env, scene.productRef),
                scene.title,
              ),
            },
          });
        }
        out.push({
          ...result,
          cases,
          aggregate: {
            ...result.aggregate,
            productFidelity: mean(cases.map((c) => c.metrics.productFidelity)),
          },
        });
      }
      return out;
    } finally {
      await judge.stop();
    }
  },
};
