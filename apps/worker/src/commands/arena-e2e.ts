import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  ARENA_CATALOG,
  type ArenaCandidate,
  championFor,
  profileIdOf,
} from "@money-maker/core/arena/catalog";
import type { RealProduct } from "@money-maker/core/arena/fixtures/real-products";
import { packageCost } from "@money-maker/core/arena/package-cost";
import {
  artDirectionInputFromReal,
  copyCaseFromReal,
  realProductsInterleaved,
  slideSceneCaseFromReal,
} from "@money-maker/core/arena/real-dataset";
import { selectReelTrack } from "@money-maker/core/assets/reel-music";
import { buildReelTimeline, type ReelClip } from "@money-maker/core/assets/reel-timeline";
import { createSpokenTextSynthesizer } from "@money-maker/core/assets/spoken-text";
import { DEFAULT_BRAND_KIT, mergeBrandKit } from "@money-maker/core/brand/brand-kit";
import { resolveNicheCaptionTheme } from "@money-maker/core/brand/caption-style";
import {
  draftOfferCopyWithCorrections,
  OFFER_COPY_SLIDE_COUNT,
  type OfferCopyDraft,
} from "@money-maker/core/content/offer-copy";
import { judgeCutout } from "@money-maker/core/creatives/cutout-qa";
import {
  isCountCritical,
  productVisualSpecFor,
  standsOnFloor,
} from "@money-maker/core/creatives/in-scene-fidelity";
import { colourName, offerSceneSeed } from "@money-maker/core/creatives/offer-scenes";
import { priceDisplayFromFacts } from "@money-maker/core/creatives/price-display";
import {
  type SceneLine,
  shotFor,
  validateSceneLines,
} from "@money-maker/core/creatives/scene-direction";
import { templateFor } from "@money-maker/core/creatives/templates";
import { autoReelVoiceScript } from "@money-maker/core/publishing/auto-reels";
import { qualitySummary } from "@money-maker/core/publishing/render-quality";
import { createLlamaServerArtDirector } from "@money-maker/providers/llm/llama-server-art-director";
import { createLlamaServerCopywriter } from "@money-maker/providers/llm/llama-server-copywriter";
import { compositeProduct } from "@money-maker/providers/media/composite-product";
import { createFfmpegReelRenderer } from "@money-maker/providers/media/ffmpeg-reel-renderer";
import { createFolderMusicLibrary } from "@money-maker/providers/media/folder-music-library";
import { imageDegeneracy } from "@money-maker/providers/media/image-sanity";
import { createKokoroSpeechSynthesizer } from "@money-maker/providers/media/kokoro-speech-synthesizer";
import { parallaxMotionFor, renderParallaxClip } from "@money-maker/providers/media/parallax-clip";
import { createRealEsrganUpscaler } from "@money-maker/providers/media/realesrgan-upscaler";
import { createSdCppImageEditor } from "@money-maker/providers/media/sdcpp-scene-generator";
import { productColours } from "@money-maker/providers/media/sharp-colour-evidence";
import { createSharpCreativeRenderer } from "@money-maker/providers/media/sharp-creative-renderer";
import { removeWhiteBackground } from "@money-maker/providers/media/white-background-remover";
import sharp from "sharp";
import { downloadFile } from "../arena/runtime.js";
import { startLlama, startSd } from "../arena/servers.js";
import { loadRefFor, refImage } from "../arena/suites/visual.js";
import { readImage, startVlmJudge } from "../arena/vlm-judge.js";
import { type ArenaRunSpec, buildJudgePage } from "./arena.js";
import { detectTarget, environment } from "./arena-run.js";
import { LOGO, PALETTE } from "./post-preview.js";

/**
 * Arena level 2, end to end: two complete pipelines make the same real products into finished
 * posts and Reels, as production would (copy loop -> scene from the listing photo -> Real-ESRGAN
 * x2 -> in-scene slides with the price drawn from facts -> narrated Reel with captions).
 * Automatic QA at every step: copy validator, product fidelity of the scene (VLM), render QA of
 * the Reel. The owner judges the finished Reels and covers blind (judge.html, judge-covers.html).
 *
 *   arena-e2e.js [--products=3] [--product=<id>] [--copy-b=<copy champion>] [--image-b=local:flux-2-klein-4b]
 *                [--reel-b=parallax|v2|v1] [--scenes-b=directed|composite] [--out=<dir>]
 *
 * Pipeline A is production today (copy and image champions, Reel v1). B defaults to the same
 * copy and image with the Reel "parallax": the v2 edit with every scene moving in 2.5D under
 * still slide text (motion arena 2026-10-08). Nothing is published or stored.
 */
const execFileAsync = promisify(execFile);
const VOICE = { casa: "pf_dora", beleza: "pf_dora", tech: "pm_alex" } as const;
const NICHE_LABEL = { casa: "Casa", beleza: "Beleza", tech: "Tech" } as const;
const ASSET_BASE =
  "https://mcp.example.com/v1/public/workspaces/WORKSPACE_ID/assets/";

export type E2EPipeline = Readonly<{
  name: string;
  dir: string;
  copyModel: string;
  imageModel: string;
  reel: "v1" | "v2" | "parallax";
  /**
   * "directed": scene lines from the copy model (art direction) instead of the slide copy.
   * "composite": directed, and the product-only slots of a count-critical product draw only a
   * backdrop that gets the real cut-out composited on it (Phase 3).
   */
  scenes: "plain" | "directed" | "composite";
}>;

type ProductOutcome = {
  productId: string;
  copy: "ok" | string;
  sceneMs: number | null;
  productFidelity: number | null;
  extraPersonRate: number | null;
  reelQa: string | null;
  reelMs: number | null;
  sceneCount: number | null;
};

const flag = (args: readonly string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const candidate = (id: string): ArenaCandidate => {
  const found = ARENA_CATALOG.find((c) => c.id === id);
  if (!found) throw new Error(`arena_candidate_unknown:${id}`);
  return found;
};

/** Blind folder names; the page shuffles left and right per pair as well. */
export const e2ePipelines = (args: readonly string[]): readonly E2EPipeline[] => {
  const copy = championFor("llm.offer_copy")?.id ?? "local:qwen3.5-9b";
  const image = championFor("image.character_product")?.id ?? "local:flux-2-klein-4b";
  const reelB = flag(args, "reel-b");
  return [
    {
      name: "A (production)",
      dir: "p1",
      copyModel: copy,
      imageModel: image,
      reel: "v1",
      // --scenes-a=directed runs production with art-directed scenes (owner review runs).
      scenes: sceneMode(flag(args, "scenes-a")),
    },
    {
      name: "B (challenger)",
      dir: "p2",
      copyModel: flag(args, "copy-b") ?? copy,
      imageModel: flag(args, "image-b") ?? image,
      reel: reelB === "v1" || reelB === "v2" ? reelB : "parallax",
      scenes: sceneMode(flag(args, "scenes-b")),
    },
  ];
};

const sceneMode = (value: string | undefined): E2EPipeline["scenes"] =>
  value === "directed" || value === "composite" ? value : "plain";

const DEPTH_MODEL = {
  url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx",
  file: "depth-anything-v2-small.onnx",
};

/** Depth map next to the scene (scripts/local-ai/depth.py through uv); null when unavailable. */
const depthFor = async (
  env: ReturnType<typeof environment>,
  scene: string,
): Promise<Uint8Array | null> => {
  const target = scene.replace(/\.png$/, ".depth.png");
  const cached = await readFile(target).catch(() => null);
  if (cached) return cached;
  const model = join(env.modelsDir, DEPTH_MODEL.file);
  await downloadFile(DEPTH_MODEL.url, model);
  await execFileAsync(
    "uv",
    ["run", "-q", join(env.repoRoot, "scripts/local-ai/depth.py"), "--model", model, scene],
    { timeout: 600_000 },
  );
  return readFile(target).catch(() => null);
};

const fileFor = (out: string, p: E2EPipeline, product: RealProduct, name: string) =>
  join(out, p.dir, product.id, name);

/** One scene per slide, as production draws them (offerSceneSlots), not one scene for all. */
const sceneFile = (slideIndex: number) => `scene-${slideIndex}.png`;
const countCritical = (product: Readonly<{ title: string }>): boolean =>
  isCountCritical(productVisualSpecFor(product.title));
const SCENE_FILES = Array.from({ length: OFFER_COPY_SLIDE_COUNT }, (_, i) => sceneFile(i + 1));

const copyPhase = async (
  env: ReturnType<typeof environment>,
  pipeline: E2EPipeline,
  products: readonly RealProduct[],
  out: string,
  outcomes: Map<string, ProductOutcome>,
) => {
  const model = candidate(pipeline.copyModel);
  for (const f of model.files) await downloadFile(f.url, join(env.modelsDir, f.file));
  const server = await startLlama(env, model);
  try {
    const copywriter = createLlamaServerCopywriter({
      baseUrl: server.baseUrl,
      model: profileIdOf(model.id),
      temperature: 0,
    });
    for (const product of products) {
      const c = copyCaseFromReal(product);
      const context = {
        facts: c.facts,
        sourceFactKeys: c.sourceFactKeys,
        // The deck size the packet asked for (beatsFor): a thin product gets fewer slides.
        slideCount: c.input.slideCount,
        channels: ["instagram_carousel", "threads"] as const,
        captionMaxLength: { threads: 500 },
      };
      const outcome = await draftOfferCopyWithCorrections(
        (correction) => copywriter.draft(c.input, correction),
        context,
      ).catch(() => null);
      const check = outcome?.check;
      const key = `${pipeline.dir}/${product.id}`;
      (outcomes.get(key) as ProductOutcome).copy = check?.ok
        ? "ok"
        : (check?.code ?? "copy_failed");
      if (check?.ok) {
        await mkdir(join(out, pipeline.dir, product.id), { recursive: true });
        await writeFile(
          fileFor(out, pipeline, product, "copy.json"),
          JSON.stringify({ slides: check.filled.slides, captions: check.captions }, null, 1),
        );
      }
      env.log(`  copy ${pipeline.dir} ${product.id}: ${check?.ok ? "ok" : check?.code}`);
    }
  } finally {
    await server.stop();
  }
};

/** Scene lines for every product's slides from the copy model (art direction, spec 2026-10-08). */
const artDirectionPhase = async (
  env: ReturnType<typeof environment>,
  pipeline: E2EPipeline,
  products: readonly RealProduct[],
  out: string,
) => {
  const model = candidate(pipeline.copyModel);
  const server = await startLlama(env, model);
  try {
    const director = createLlamaServerArtDirector({
      baseUrl: server.baseUrl,
      model: profileIdOf(model.id),
    });
    for (const product of products) {
      const copy = await readFile(fileFor(out, pipeline, product, "copy.json"), "utf8").catch(
        () => null,
      );
      if (!copy) continue;
      const { slides } = JSON.parse(copy) as Pick<OfferCopyDraft, "slides">;
      const input = artDirectionInputFromReal(product, slides);
      const raw = await director.direct(input).catch((error: unknown) => {
        env.log(`  art direction ${pipeline.dir} ${product.id}: ${(error as Error).message}`);
        return null;
      });
      const lines = validateSceneLines(raw, input);
      await writeFile(
        fileFor(out, pipeline, product, "scene-lines.json"),
        JSON.stringify(lines, null, 1),
      );
      env.log(
        `  art direction ${pipeline.dir} ${product.id}: ${lines.filter((l) => l.source === "model").length}/${lines.length} model lines`,
      );
    }
  } finally {
    await server.stop();
  }
};

const scenePhase = async (
  env: ReturnType<typeof environment>,
  pipeline: E2EPipeline,
  products: readonly RealProduct[],
  out: string,
  outcomes: Map<string, ProductOutcome>,
  loadRef: (ref: string) => Promise<Uint8Array>,
) => {
  const model = candidate(pipeline.imageModel);
  const launch = model.launch;
  if (launch.runtime !== "sd-server") throw new Error("arena_launch_mismatch");
  for (const f of model.files) await downloadFile(f.url, join(env.modelsDir, f.file));
  const server = await startSd(env, model);
  try {
    const editor = createSdCppImageEditor({
      baseUrl: server.baseUrl,
      model: profileIdOf(model.id),
      steps: launch.steps,
      referenceMaxSide: 512,
      timeoutMs: 1_800_000,
      arena: true,
    });
    for (const product of products) {
      const copy = await readFile(fileFor(out, pipeline, product, "copy.json"), "utf8").catch(
        () => null,
      );
      if (!copy) continue;
      const { slides } = JSON.parse(copy) as Pick<OfferCopyDraft, "slides">;
      let lines: SceneLine[] = [];
      if (pipeline.scenes !== "plain") {
        const saved = await readFile(
          fileFor(out, pipeline, product, "scene-lines.json"),
          "utf8",
        ).catch(() => null);
        if (!saved) {
          env.log(`  scene ${pipeline.dir} ${product.id}: scene lines missing`);
          continue;
        }
        lines = JSON.parse(saved) as SceneLine[];
      }
      // The listing photo's own colours, like production (offer-scene-task colourNames); none
      // when the reference check called the photo not clean.
      const refCheck = await readFile(
        fileFor(out, pipeline, product, "reference-check.json"),
        "utf8",
      ).catch(() => null);
      const colours =
        refCheck && (JSON.parse(refCheck) as { clean: boolean | null }).clean === false
          ? []
          : (await productColours(await loadRef(product.photo)).catch(() => [])).map(colourName);
      // Composite pipeline: the real cut-out, when the cut-out check (cutoutPhase) passed it.
      const checked = await readFile(
        fileFor(out, pipeline, product, "cutout-check.json"),
        "utf8",
      ).catch(() => null);
      const cleanCutout =
        pipeline.scenes === "composite" &&
        checked &&
        (JSON.parse(checked) as { verdict: string }).verdict === "pass"
          ? await removeWhiteBackground(await loadRef(product.photo)).catch(() => null)
          : null;
      const times: number[] = [];
      for (const slide of slides) {
        const path = fileFor(out, pipeline, product, sceneFile(slide.index));
        const label = `scene ${pipeline.dir} ${product.id} #${slide.index}`;
        // A rerun keeps the scenes already drawn (about 3 minutes each on the desktop).
        if (
          await readFile(path).then(
            () => true,
            () => false,
          )
        ) {
          env.log(`  ${label}: kept`);
          continue;
        }
        const line = lines.find((l) => l.index === slide.index)?.line;
        const shot = shotFor(slide, countCritical(product));
        const backdrop = cleanCutout !== null && shot.people === 0;
        const scene = slideSceneCaseFromReal(
          product,
          slide,
          line ? { line, people: shot.people, backdrop } : undefined,
          colours,
        );
        const started = performance.now();
        try {
          const refs = await Promise.all(scene.references.map(loadRef));
          // Pinned per slide like production (offerSceneSeed): the provider would otherwise seed
          // by prompt, and two slots with the same line drew the same image (2026-10-09).
          const image = await editor.edit(
            scene.prompt,
            refs,
            { width: scene.width, height: scene.height },
            { seed: offerSceneSeed(product.id, { slideIndex: slide.index, canvas: "feed" }, 1) },
          );
          const degenerate = await imageDegeneracy(image.bytes);
          if (degenerate) {
            env.log(`  ${label}: ${degenerate} image, dropped`);
            continue;
          }
          const bytes =
            backdrop && cleanCutout
              ? await compositeProduct(image.bytes, cleanCutout.png, {
                  floor: standsOnFloor(product.title),
                })
              : image.bytes;
          await mkdir(join(out, pipeline.dir, product.id), { recursive: true });
          await writeFile(path, bytes);
          times.push(performance.now() - started);
          env.log(`  ${label}: ${Math.round((performance.now() - started) / 1000)} s`);
        } catch (error) {
          env.log(`  ${label}: ${(error as Error).message}`);
        }
      }
      const sceneMs = mean(times);
      if (sceneMs !== null)
        (outcomes.get(`${pipeline.dir}/${product.id}`) as ProductOutcome).sceneMs =
          Math.round(sceneMs);
    }
  } finally {
    await server.stop();
  }
};

/**
 * Cut-out check (Phase 3): the listing photo's cut-out is judged alone by the vision champion
 * (counts on the cut-out, like production `cutoutCheck`), because listing photos are often
 * collages (2026-10-09: loaded rack, empty rack and a room inset on one white background).
 */
const cutoutPhase = async (
  env: ReturnType<typeof environment>,
  pipeline: E2EPipeline,
  products: readonly RealProduct[],
  out: string,
  loadRef: (ref: string) => Promise<Uint8Array>,
) => {
  const judge = await startVlmJudge(env);
  try {
    for (const product of products) {
      // Reference photo check (11.1) for every product: a styled or collage photo states no
      // colours in the scene prompt and never feeds the composite.
      const refFile = fileFor(out, pipeline, product, "reference-check.json");
      if (
        !(await readFile(refFile).then(
          () => true,
          () => false,
        ))
      ) {
        const check = await judge.referenceCheck(await refImage(env, product.photo), product.title);
        await mkdir(join(out, pipeline.dir, product.id), { recursive: true });
        await writeFile(refFile, JSON.stringify(check ?? { clean: null }, null, 1));
        env.log(
          `  reference ${pipeline.dir} ${product.id}: ${check ? (check.clean ? "clean" : `not clean ${check.extras.join(",")}`) : "no answer"}`,
        );
      }
      if (pipeline.scenes !== "composite" || !countCritical(product)) continue;
      const file = fileFor(out, pipeline, product, "cutout-check.json");
      if (
        await readFile(file).then(
          () => true,
          () => false,
        )
      )
        continue;
      const photo = await loadRef(product.photo);
      const cutout = await removeWhiteBackground(photo).catch(() => null);
      const shape = cutout ? judgeCutout(cutout.metrics) : { ok: false, reason: "no_cutout" };
      let verdict: { verdict: string; reasons: readonly string[]; counts?: unknown } = {
        verdict: "block",
        reasons: [shape.ok ? "" : shape.reason].filter(Boolean),
      };
      if (cutout && shape.ok) {
        const check = await judge.sceneCheck(
          { bytes: cutout.png, mimeType: "image/png" },
          await refImage(env, product.photo),
          product.title,
        );
        verdict = check
          ? {
              verdict: check.fidelity === 1 ? "pass" : "block",
              reasons: check.reasons,
              counts: check.counts,
            }
          : { verdict: "block", reasons: ["vlm_unavailable"] };
      }
      await mkdir(join(out, pipeline.dir, product.id), { recursive: true });
      await writeFile(file, JSON.stringify(verdict, null, 1));
      env.log(
        `  cut-out ${pipeline.dir} ${product.id}: ${verdict.verdict} ${verdict.reasons.join(",")}`,
      );
    }
  } finally {
    await judge.stop();
  }
};

/** Real-ESRGAN x2 (the upscale champion) through the desktop exe; lanczos elsewhere. */
const upscale = async (scene: string, target: string) => {
  const exe = (
    await execFileAsync("find", [
      "/mnt/e/ai/realesrgan",
      "-name",
      "realesrgan-ncnn-vulkan.exe",
    ]).catch(() => ({ stdout: "" }))
  ).stdout
    .split("\n")
    .find(Boolean);
  if (!exe) {
    const meta = await sharp(scene).metadata();
    await sharp(scene)
      .resize((meta.width ?? 512) * 2, (meta.height ?? 640) * 2, { kernel: "lanczos3" })
      .png()
      .toFile(target);
    return;
  }
  await writeFile(target, await createRealEsrganUpscaler({ exe })(await readFile(scene)));
};

export const renderPhase = async (
  env: ReturnType<typeof environment>,
  pipelines: readonly E2EPipeline[],
  products: readonly RealProduct[],
  out: string,
  outcomes: Map<string, ProductOutcome>,
) => {
  const renderer = createSharpCreativeRenderer();
  const music = process.env.REEL_MUSIC_DIR
    ? createFolderMusicLibrary(process.env.REEL_MUSIC_DIR)
    : null;
  const usedTracks: string[] = [];
  const ttsUrl = process.env.TTS_URL ?? "http://127.0.0.1:8880";
  const speech = createSpokenTextSynthesizer(createKokoroSpeechSynthesizer({ baseUrl: ttsUrl }));
  const logos = new Map<string, Uint8Array | null>();
  const logo = async (id: string) => {
    if (!logos.has(id))
      logos.set(
        id,
        await fetch(`${ASSET_BASE}${id}`)
          .then(async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null))
          .catch(() => null),
      );
    return logos.get(id) ?? null;
  };
  for (const pipeline of pipelines) {
    const reels = createFfmpegReelRenderer(pipeline.reel === "v1" ? {} : { editStyle: "v2" });
    for (const product of products) {
      const o = outcomes.get(`${pipeline.dir}/${product.id}`) as ProductOutcome;
      const copy = await readFile(fileFor(out, pipeline, product, "copy.json"), "utf8").catch(
        () => null,
      );
      if (!copy) continue;
      const draft = JSON.parse(copy) as Pick<OfferCopyDraft, "slides">;
      // Each slide on its own upscaled scene; a product missing any scene is not rendered.
      const backgrounds: { path: string; bytes: Buffer }[] = [];
      for (const slide of draft.slides) {
        const scenePath = fileFor(out, pipeline, product, sceneFile(slide.index));
        const scene = await readFile(scenePath).catch(() => null);
        if (!scene) break;
        const big = scenePath.replace(/\.png$/, "-2x.png");
        await upscale(scenePath, big).catch(() => undefined);
        const upscaled = await readFile(big).catch(() => null);
        backgrounds.push(
          upscaled ? { path: big, bytes: upscaled } : { path: scenePath, bytes: scene },
        );
      }
      if (backgrounds.length !== draft.slides.length) {
        env.log(`  post+reel ${pipeline.dir} ${product.id}: scenes missing`);
        continue;
      }
      const label = NICHE_LABEL[product.niche];
      const price = priceDisplayFromFacts(product.facts, {
        id: `arena-${product.providerId}`,
        verifiedAt: new Date("2026-10-07T00:00:00Z"),
      });
      const logoPng = await logo(LOGO[label]);
      const slides: Uint8Array[] = [];
      const overlays: (Uint8Array | undefined)[] = [];
      for (const [index, slide] of draft.slides.entries()) {
        const rendered = await renderer.render({
          canvas: "feed",
          template: templateFor(slide.template, "feed"),
          spec: slide,
          brand: mergeBrandKit(DEFAULT_BRAND_KIT, {
            brandName: "Example Shop",
            nicheLabel: label,
            palette: PALETTE[label],
          }),
          product: { inScene: true },
          background: {
            png: new Uint8Array((backgrounds[index] as (typeof backgrounds)[0]).bytes),
          },
          ...((slide.badge || slide.template === "price") && price ? { price } : {}),
          ...(slide.index === draft.slides.length ? { cta: "Link na bio" } : {}),
          ...(logoPng ? { logo: { png: logoPng } } : {}),
        });
        await writeFile(
          fileFor(out, pipeline, product, `slide-${slide.index}.jpg`),
          rendered.bytes,
        );
        slides.push(rendered.bytes);
        overlays.push(rendered.overlay);
      }
      await writeFile(join(out, pipeline.dir, `${product.id}.jpg`), slides[0] as Uint8Array);
      try {
        const clips: ReelClip[] = [];
        const voiceClips: Uint8Array[] = [];
        for (const text of autoReelVoiceScript(draft.slides)) {
          const clip = await speech.synthesize({
            text,
            voiceId: VOICE[product.niche],
            language: "pt-BR",
          });
          clips.push({ durationMs: clip.durationMs, words: clip.words });
          voiceClips.push(clip.bytes);
        }
        const timeline = buildReelTimeline({
          slideCount: slides.length,
          clips,
          ...(reels.crossfadeSec !== undefined ? { crossfadeSec: reels.crossfadeSec } : {}),
        });
        const theme = resolveNicheCaptionTheme({
          niche: { context: { captionTheme: { preset: "boxed" } } },
          canvas: "portrait",
        });
        const reelSlides = [];
        for (const [index, bytes] of slides.entries()) {
          const overlay = overlays[index];
          const background = backgrounds[index] as (typeof backgrounds)[0];
          const depth = pipeline.reel === "parallax" ? await depthFor(env, background.path) : null;
          if (pipeline.reel === "parallax" && !depth) throw new Error("depth_unavailable");
          if (!depth || !overlay) {
            reelSlides.push({ bytes, mimeType: "image/jpeg", width: 1080, height: 1350 });
            continue;
          }
          const clip = fileFor(out, pipeline, product, `slide-${index + 1}.mp4`);
          await renderParallaxClip({
            scene: new Uint8Array(background.bytes),
            depth,
            overlay,
            motion: parallaxMotionFor(index),
            width: 1080,
            height: 1350,
            canvas: { width: 1080, height: 1920 },
            durationSec: timeline.slides[index]?.durationSec ?? 3,
            outputPath: clip,
          });
          reelSlides.push({
            bytes: new Uint8Array(await readFile(clip)),
            mimeType: "video/mp4",
            width: 1080,
            height: 1920,
          });
        }
        // Background music the way production picks it (REEL_MUSIC_DIR, licensed folder).
        const track = music
          ? selectReelTrack({
              tracks: await music.listTracks(),
              nicheWords: [product.niche],
              recentTrackIds: [...usedTracks],
            })
          : undefined;
        if (track) usedTracks.unshift(track.id);
        const reel = await reels.render({
          slides: reelSlides,
          timeline,
          voiceClips,
          ...(track ? { musicFile: track.file } : {}),
          ...(theme ? { captionStyle: { theme } } : {}),
        });
        await writeFile(join(out, pipeline.dir, `${product.id}.mp4`), reel.bytes);
        o.reelQa = reel.quality ? qualitySummary(reel.quality).verdict : null;
        o.reelMs = reel.durationMs;
      } catch (error) {
        o.reelQa = `failed:${(error as Error).message.slice(0, 60)}`;
      }
      env.log(`  post+reel ${pipeline.dir} ${product.id}: reel ${o.reelQa}`);
    }
  }
};

const mean = (values: readonly (number | null)[]) => {
  const v = values.filter((x): x is number => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const repoRoot = resolve(process.cwd());
  const env = environment(await detectTarget(), repoRoot, "real");
  const count = Number(flag(args, "products") ?? 3);
  // --product=<id> runs one named product instead of the first N of the interleaved list.
  const only = flag(args, "product");
  const products = only
    ? realProductsInterleaved().filter((p) => p.id === only)
    : realProductsInterleaved().slice(0, count);
  const pipelines = e2ePipelines(args);
  const out =
    flag(args, "out") ??
    join(repoRoot, "reports/ai-arena", new Date().toISOString().slice(0, 10), "e2e-real");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "pipelines.json"), JSON.stringify(pipelines, null, 1));
  const outcomes = new Map<string, ProductOutcome>();
  for (const p of pipelines)
    for (const product of products)
      outcomes.set(`${p.dir}/${product.id}`, {
        productId: product.id,
        copy: "not_run",
        sceneMs: null,
        sceneCount: null,
        productFidelity: null,
        extraPersonRate: null,
        reelQa: null,
        reelMs: null,
      });
  const loadRef = (ref: string) => loadRefFor(env, ref);
  env.log(
    `e2e: ${products.length} real products, pipelines ${pipelines.map((p) => p.name).join(" vs ")}`,
  );
  // A phase that cannot start (download, runtime, OOM) is logged; the other phases still run.
  const phase = (name: string, run: () => Promise<void>) =>
    run().catch((error: unknown) =>
      env.log(`  ${name} skipped: ${error instanceof Error ? error.message : "failed"}`),
    );
  // B with A's model reuses A's output, so the pair differs only where the pipelines differ.
  const [a] = pipelines;
  const reuse = async (p: E2EPipeline, files: readonly string[], field: "copy" | "sceneMs") => {
    if (!a || p === a) return false;
    for (const product of products) {
      const from = outcomes.get(`${a.dir}/${product.id}`) as ProductOutcome;
      const to = outcomes.get(`${p.dir}/${product.id}`) as ProductOutcome;
      if (field === "copy") to.copy = from.copy;
      else to.sceneMs = from.sceneMs;
      for (const file of files) {
        const bytes = await readFile(fileFor(out, a, product, file)).catch(() => null);
        if (!bytes) continue;
        await mkdir(join(out, p.dir, product.id), { recursive: true });
        await writeFile(fileFor(out, p, product, file), bytes);
      }
    }
    env.log(
      `  ${files[0]}${files.length > 1 ? ` +${files.length - 1}` : ""} ${p.dir}: reused from ${a.dir} (same model)`,
    );
    return true;
  };
  for (const p of pipelines)
    if (!(p.copyModel === a?.copyModel && (await reuse(p, ["copy.json"], "copy"))))
      await phase(`copy ${p.dir}`, () => copyPhase(env, p, products, out, outcomes));
  for (const p of pipelines)
    if (p.scenes !== "plain")
      await phase(`art direction ${p.dir}`, () => artDirectionPhase(env, p, products, out));
  for (const p of pipelines)
    if (p.scenes !== "plain")
      await phase(`reference check ${p.dir}`, () => cutoutPhase(env, p, products, out, loadRef));
  for (const p of pipelines)
    if (
      !(
        p.imageModel === a?.imageModel &&
        p.scenes === a?.scenes &&
        (await reuse(p, SCENE_FILES, "sceneMs"))
      )
    )
      await phase(`scenes ${p.dir}`, () => scenePhase(env, p, products, out, outcomes, loadRef));

  // Product fidelity of every scene, with the vision champion as judge.
  await phase("product fidelity", async () => {
    const judge = await startVlmJudge(env);
    try {
      for (const p of pipelines)
        for (const product of products) {
          // The share of the product's slide scenes in which the judge finds the product.
          const copy = await readFile(fileFor(out, p, product, "copy.json"), "utf8").catch(
            () => null,
          );
          if (!copy) continue;
          const { slides } = JSON.parse(copy) as Pick<OfferCopyDraft, "slides">;
          const scores: (number | null)[] = [];
          const extras: number[] = [];
          const checks: unknown[] = [];
          for (const slide of slides) {
            const scene = await readImage(fileFor(out, p, product, sceneFile(slide.index))).catch(
              () => null,
            );
            if (!scene) continue;
            const check = await judge.sceneCheck(
              scene,
              await refImage(env, product.photo),
              product.title,
            );
            scores.push(check?.fidelity ?? null);
            checks.push({ index: slide.index, ...(check ?? { fidelity: null }) });
            // Plain scenes always draw the character (one person allowed); directed shots allow
            // what their shot says.
            const allowed =
              p.scenes === "plain" ? 1 : shotFor(slide, countCritical(product)).people;
            if (check && check.peopleCount !== null)
              extras.push(check.peopleCount > allowed ? 1 : 0);
          }
          // Per-scene verdicts next to the scenes: which slot failed and what the VLM counted.
          await writeFile(
            fileFor(out, p, product, "scene-checks.json"),
            JSON.stringify(checks, null, 1),
          );
          const outcome = outcomes.get(`${p.dir}/${product.id}`) as ProductOutcome;
          outcome.sceneCount = scores.length;
          if (scores.length) outcome.productFidelity = mean(scores);
          if (extras.length) outcome.extraPersonRate = mean(extras);
        }
    } finally {
      await judge.stop();
    }
  });

  await phase("render", () => renderPhase(env, pipelines, products, out, outcomes));

  const summary = pipelines.map((p) => {
    const rows = products.map(
      (product) => outcomes.get(`${p.dir}/${product.id}`) as ProductOutcome,
    );
    return {
      pipeline: p,
      copyPassRate: rows.filter((r) => r.copy === "ok").length / rows.length,
      productFidelity: mean(rows.map((r) => r.productFidelity)),
      extraPersonRate: mean(rows.map((r) => r.extraPersonRate)),
      reelQaPassRate:
        rows.filter((r) => r.reelQa === "pass" || r.reelQa === "warn").length / rows.length,
      meanSceneSec: (mean(rows.map((r) => r.sceneMs)) ?? 0) / 1000,
      meanReelSec: (mean(rows.map((r) => r.reelMs)) ?? 0) / 1000,
      cost: packageCost(rows),
      rows,
    };
  });
  await writeFile(join(out, "e2e-summary.json"), JSON.stringify(summary, null, 1));
  const md = [
    "# End-to-end arena (real products)",
    "",
    "| Pipeline | copy | image | Reel | copy pass | product fidelity | extra person | Reel QA pass | scene s | Reel s | packages passing (95% CI) | GPU s / passing package |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (s) =>
        `| ${s.pipeline.name} | ${s.pipeline.copyModel} | ${s.pipeline.imageModel} | ${s.pipeline.reel} | ${s.copyPassRate.toFixed(2)} | ${s.productFidelity?.toFixed(2) ?? "n/a"} | ${s.extraPersonRate?.toFixed(2) ?? "n/a"} | ${s.reelQaPassRate.toFixed(2)} | ${s.meanSceneSec.toFixed(0)} | ${s.meanReelSec.toFixed(1)} | ${s.cost.passing}/${s.cost.packages}${s.cost.passRate95 ? ` (${s.cost.passRate95.low.toFixed(2)}-${s.cost.passRate95.high.toFixed(2)})` : ""} | ${s.cost.gpuSecPerPassingPackage ?? "n/a"} |`,
    ),
    "",
    "Packages passing: every scene passed the fidelity judge, no extra person, Reel QA not blocked. GPU time counts scenes drawn in this run only (kept scenes cost 0).",
    "",
    "Owner check: judge.html (whole Reels) and judge-covers.html (cover slides), blind.",
    "",
  ].join("\n");
  await writeFile(join(out, "e2e-summary.md"), md);

  for (const [media, page, file] of [
    [{ kind: "video" as const, ext: "mp4" }, "judge.html", "arena.json"],
    [{ kind: "image" as const, ext: "jpg" }, "judge-covers.html", "arena-covers.json"],
  ] as const) {
    const spec: ArenaRunSpec = {
      task: `e2e.${media.kind === "video" ? "reel" : "cover"}`,
      champion: pipelines[0]?.name ?? "A",
      media,
      candidates: pipelines.map((p) => ({ id: p.name, dir: p.dir })),
      cases: products.map((product) => ({ caseId: product.id, brief: product.title })),
    };
    await writeFile(join(out, file), JSON.stringify(spec, null, 1));
    const available = new Set<string>();
    for (const p of pipelines)
      for (const f of await readdir(join(out, p.dir)).catch(() => [] as string[]))
        available.add(`${p.dir}/${f}`);
    await writeFile(join(out, page), buildJudgePage(spec, available, Date.now() % 1e9));
  }
  console.log(md);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "arena e2e failed");
    process.exitCode = 1;
  });
}
