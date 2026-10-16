// apps/worker/src/commands/style-frames.ts

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseWorkerEnvironment } from "@money-maker/config";
import { ACTING_PRESETS, type ActingProfile } from "@money-maker/core/explainer/acting";
import {
  type BackgroundArt,
  EXPLAINER_BACKGROUND_PROMPT_VERSION,
  EXPLAINER_BACKGROUND_SIZE,
  explainerBackgroundPrompt,
} from "@money-maker/core/explainer/background-art";
import type { BackgroundId } from "@money-maker/core/explainer/backgrounds";
import {
  COMPOSITING_HYPOTHESIS,
  type CompositingProfile,
  DEFAULT_COMPOSITING,
  type PlatePostProcessPlan,
  platePostProcessPlan,
  readCompositingProfile,
} from "@money-maker/core/explainer/compositing";
import {
  DEFAULT_SCENE_PALETTE,
  type ExplainerCharacter,
} from "@money-maker/core/explainer/explainer-context";
import { SAM } from "@money-maker/core/explainer/fixtures/cast/cost-curious-cast";
import {
  STYLE_CANDIDATES,
  type StyleCandidate,
} from "@money-maker/core/explainer/fixtures/style-frames/candidates";
import {
  MOTION_TEST_ID,
  STYLE_FRAME_CAPTION_WORDS,
  STYLE_FRAME_CAST,
  STYLE_FRAME_SHOTS,
  type StyleFrameGrade,
  type StyleFrameShot,
  styleFrameScene,
  styleFrameTiming,
} from "@money-maker/core/explainer/fixtures/style-frames/fixtures";
import { composeMotionFrame } from "@money-maker/core/explainer/motion/frame";
import { type MotionPlan, planMotion } from "@money-maker/core/explainer/motion/plan";
import { sniffImageMimeType } from "@money-maker/providers/cloudflare/workers-ai-scene-generator";
import { configureBundledFonts } from "@money-maker/providers/media/fonts";
import {
  measureFocalContrast,
  postProcessPlate,
} from "@money-maker/providers/media/plate-postprocess";
import { createStickmanMotionRenderer } from "@money-maker/providers/media/stickman-motion-renderer";
import {
  gradePlateImage,
  imageVersions,
  type PlateGrade,
  rasterizeFrame,
  STYLE_FRAME_SIZE,
  STYLE_THUMB_SIZE,
  thumbnailFrame,
  tileSheet,
} from "@money-maker/providers/media/style-frame-images";
import { sceneGeneratorFor } from "../scene-generator.js";

/**
 * Style-frame harness (video slice 13, spec v2 section 9): renders the fixture shots and the
 * 6-second motion test once per style candidate into a review folder, with 160x284 thumbnails,
 * blind side-by-side sheets (labels A/B/C, key sealed in its own file) and a manifest that
 * records how every artifact was produced. An engineering tool for the owner's visual review,
 * not a production path: nothing here writes a profile or touches the database.
 *
 * Plates: `<platesDir>/<candidateId>/<background>.png|.jpg` (+ optional `<background>.json`
 * provenance). `generate-plates` fills that folder through the configured SceneGenerator and
 * writes provenance; `render` never generates. A missing plate draws the procedural setting and
 * the manifest says so (`plate: "fallback"`), so a review never mistakes a gap for a style.
 */
const exec = promisify(execFile);

export const THUMB = STYLE_THUMB_SIZE;
const FRAME = STYLE_FRAME_SIZE;
const BLIND_LABELS = ["A", "B", "C", "D", "E", "F"] as const;
/** Harness-only grades for frames 8 and 9 (spec open question 5); not a production operation. */
const GRADES: Readonly<Record<StyleFrameGrade, PlateGrade>> = {
  night: { brightness: 0.45, saturation: 0.7, tint: "#3b4a7a" },
  warm: { brightness: 1.05, saturation: 1.1, tint: "#ffb347" },
};

export type Plate = Readonly<{
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  provenance: unknown;
}>;
export type PlateSource = Readonly<{
  load(candidateId: string, background: BackgroundId): Promise<Plate | null>;
}>;

export type StyleFrameDeps = Readonly<{
  /** Rasterises a 1080x1920 SVG to PNG bytes. */
  rasterize(svg: string): Promise<Uint8Array>;
  /** Downscales a PNG to THUMB. */
  thumbnail(png: Uint8Array): Promise<Uint8Array>;
  /** Tiles PNGs left to right at the given tile size with a label over each. */
  sheet(
    tiles: readonly Readonly<{ label: string; png: Uint8Array }>[],
    tile: Readonly<{ width: number; height: number }>,
  ): Promise<Uint8Array>;
  gradePlate(plate: Plate, grade: StyleFrameGrade): Promise<Plate>;
  voiceClip(durationMs: number): Promise<Uint8Array>;
  renderMotion(plan: MotionPlan, voiceClip: Uint8Array, voiceStartMs: number): Promise<Uint8Array>;
  plates: PlateSource;
  gitHead(): Promise<string>;
  ffmpegVersion(): Promise<string>;
  now(): Date;
  /** Compositing post-process of a plate (slice 14); absent uses plates as they are. */
  postProcessPlate?(plate: Plate, plan: PlatePostProcessPlan): Promise<Plate>;
  /** Figure-ground contrast from two renders of one frame, with and without actors. */
  focalContrast?(
    withActors: Uint8Array,
    withoutActors: Uint8Array,
  ): Promise<Readonly<{ contrast: number; maskPx: number; ringPx: number }>>;
}>;

export type StyleFrameOptions = Readonly<{
  outDir: string;
  candidates?: readonly string[] | undefined;
  /** Seeds the blind label permutations; recorded in the manifest so a review is reproducible. */
  blindSeed?: number | undefined;
  /** Skip the motion test (stills only) for quick iterations. */
  skipMotion?: boolean | undefined;
  /** Compositing profile for every candidate (slice 14); absent renders today's compositing. */
  compositing?: CompositingProfile | undefined;
  /** Motion grammar for stills and the motion test (slice 15). */
  motionGrammar?: boolean | undefined;
}>;

/** Frames whose figure-ground halo the spec checks (slice 14 acceptance: 3, 6 and 8). */
export const HALO_CHECK_FRAMES: readonly number[] = [3, 6, 8];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const dataUri = (plate: Plate): string =>
  `data:${plate.mimeType};base64,${Buffer.from(plate.bytes).toString("base64")}`;

/** Deterministic permutation of `n` items from a 32-bit seed (mulberry32 + Fisher-Yates). */
export const blindOrder = (seed: number, n: number): readonly number[] => {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j] as number, order[i] as number];
  }
  return order;
};
const seedFor = (seed: number, key: string): number =>
  Number.parseInt(createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0, 8), 16);

const shotPlan = (
  shot: StyleFrameShot,
  candidate: StyleCandidate,
  art: BackgroundArt | undefined,
  compositing?: CompositingProfile | undefined,
  withoutActors = false,
  motionGrammar = false,
  cast: readonly ExplainerCharacter[] = STYLE_FRAME_CAST,
): MotionPlan => {
  const shotScene = styleFrameScene(shot);
  const scene = withoutActors ? { ...shotScene, actors: [] } : shotScene;
  const key = `style-frame:${shot.id}`;
  return planMotion({
    scenes: [art ? { ...scene, backgroundAssetId: key } : scene],
    timings: [styleFrameTiming(shot)],
    characters: cast,
    palette: DEFAULT_SCENE_PALETTE,
    captionWords: STYLE_FRAME_CAPTION_WORDS,
    durationMs: shot.durationMs,
    lineStyle: candidate.lineStyle,
    backgroundArt: art ? new Map([[key, art]]) : undefined,
    ...(compositing ? { compositing } : {}),
    ...(motionGrammar ? { motionGrammar } : {}),
  });
};

/**
 * Input plates for the Cost Curious cloud clip trial: Sam in Alex's place, no captions (image-to-video
 * would animate and garble burned-in text), Sam alone in frame. The owner approves one before a
 * paid run. Portrait 1080x1920, the harness frame.
 */
export const SAM_PLATE_SHOTS = [
  "03-establishing-wide",
  "01-character-model-front",
  "02-expression-doubt",
] as const;
export const SAM_PLATE_CAST: readonly ExplainerCharacter[] = STYLE_FRAME_CAST.map((character) =>
  character.key === "alex" ? { ...SAM, key: "alex" } : character,
);

export const renderSamPlates = async (
  deps: Pick<StyleFrameDeps, "rasterize" | "gradePlate" | "plates">,
  options: Readonly<{
    outDir: string;
    candidateId?: string | undefined;
    compositing?: CompositingProfile | undefined;
  }>,
): Promise<readonly string[]> => {
  const candidateId = options.candidateId ?? "expressive-ink-gouache-painted";
  const candidate = STYLE_CANDIDATES.find((item) => item.id === candidateId);
  if (!candidate) throw new Error("style_candidate_unknown");
  const files: string[] = [];
  for (const id of SAM_PLATE_SHOTS) {
    const shot = STYLE_FRAME_SHOTS.find((item) => item.id === id);
    if (!shot) throw new Error(`style_frame_missing:${id}`);
    const raw = candidate.plateStyle
      ? await deps.plates.load(candidate.id, shot.scene.background)
      : null;
    const plate = raw && shot.grade ? await deps.gradePlate(raw, shot.grade) : raw;
    const silent = { ...shot, scene: { ...shot.scene, captionMode: "none" as const } };
    const svg = composeMotionFrame(
      shotPlan(
        silent,
        candidate,
        plate ? { href: dataUri(plate) } : undefined,
        options.compositing,
        false,
        false,
        SAM_PLATE_CAST,
      ),
      shot.atMs,
    );
    const path = join(options.outDir, `sam-${candidate.id}-${id}.png`);
    await mkdir(options.outDir, { recursive: true });
    await writeFile(path, await deps.rasterize(svg));
    files.push(path);
  }
  return files;
};

type ShotRecord = Readonly<{
  id: string;
  frame: number;
  title: string;
  judge: string;
  optional: boolean;
  atMs: number;
  plate: "plate" | "graded_plate" | "fallback" | "procedural";
  file: string;
  thumb: string;
  sha256: string;
  halo?:
    | Readonly<{ contrast: number; target: number; verdict: "pass" | "warn"; heroAreaPct: number }>
    | undefined;
}>;

export const renderStyleFrames = async (
  deps: StyleFrameDeps,
  options: StyleFrameOptions,
): Promise<Readonly<{ manifestPath: string; files: readonly string[] }>> => {
  const wanted = options.candidates?.length
    ? STYLE_CANDIDATES.filter((candidate) => options.candidates?.includes(candidate.id))
    : STYLE_CANDIDATES;
  if (wanted.length === 0) throw new Error("style_candidates_empty");
  const blindSeed = options.blindSeed ?? 20260930;
  const files: string[] = [];
  const write = async (relative: string, bytes: Uint8Array | string): Promise<string> => {
    const path = join(options.outDir, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
    files.push(relative);
    return relative;
  };

  const stills = STYLE_FRAME_SHOTS.filter((shot) => shot.id !== MOTION_TEST_ID);
  const motion = STYLE_FRAME_SHOTS.find((shot) => shot.id === MOTION_TEST_ID);
  if (!motion) throw new Error("style_motion_test_missing");
  const frames = new Map<string, Map<string, Uint8Array>>(); // candidate -> shot -> png
  const thumbs = new Map<string, Map<string, Uint8Array>>();
  const candidateRecords: unknown[] = [];

  for (const candidate of wanted) {
    const plateCache = new Map<BackgroundId, Plate | null>();
    const postPlan = options.compositing
      ? platePostProcessPlan(options.compositing, DEFAULT_SCENE_PALETTE)
      : null;
    const plateRecords: Record<string, unknown> = {};
    const loadPlate = async (background: BackgroundId): Promise<Plate | null> => {
      if (!candidate.plateStyle) return null;
      if (!plateCache.has(background)) {
        const raw = await deps.plates.load(candidate.id, background);
        const plate =
          raw && postPlan && deps.postProcessPlate
            ? await deps.postProcessPlate(raw, postPlan)
            : raw;
        plateCache.set(background, plate);
        plateRecords[background] = plate
          ? {
              sha256: sha256(plate.bytes),
              mimeType: plate.mimeType,
              provenance: plate.provenance,
              ...(raw && plate !== raw ? { sourceSha256: sha256(raw.bytes) } : {}),
            }
          : { fallback: "procedural setting: no plate file" };
      }
      return plateCache.get(background) ?? null;
    };
    const perShot = new Map<string, Uint8Array>();
    const perThumb = new Map<string, Uint8Array>();
    const shotRecords: ShotRecord[] = [];
    for (const shot of stills) {
      const plate = await loadPlate(shot.scene.background);
      const graded = plate && shot.grade ? await deps.gradePlate(plate, shot.grade) : plate;
      const art = graded ? { href: dataUri(graded) } : undefined;
      const svg = composeMotionFrame(
        shotPlan(shot, candidate, art, options.compositing, false, options.motionGrammar),
        shot.atMs,
      );
      const png = await deps.rasterize(svg);
      let halo: ShotRecord["halo"];
      if (deps.focalContrast && HALO_CHECK_FRAMES.includes(shot.frame)) {
        const empty = await deps.rasterize(
          composeMotionFrame(
            shotPlan(shot, candidate, art, options.compositing, true, options.motionGrammar),
            shot.atMs,
          ),
        );
        const measured = await deps.focalContrast(png, empty);
        const target = (options.compositing ?? DEFAULT_COMPOSITING).focalContrastTarget;
        halo = {
          contrast: measured.contrast,
          target,
          verdict: measured.contrast >= target ? "pass" : "warn",
          heroAreaPct: Math.round((measured.maskPx / (FRAME.width * FRAME.height)) * 10_000) / 100,
        };
      }
      const thumb = await deps.thumbnail(png);
      perShot.set(shot.id, png);
      perThumb.set(shot.id, thumb);
      shotRecords.push({
        id: shot.id,
        frame: shot.frame,
        title: shot.title,
        judge: shot.judge,
        optional: shot.optional ?? false,
        atMs: shot.atMs,
        plate: !candidate.plateStyle
          ? "procedural"
          : !plate
            ? "fallback"
            : shot.grade
              ? "graded_plate"
              : "plate",
        file: await write(`${candidate.id}/frames/${shot.id}.png`, png),
        thumb: await write(`${candidate.id}/thumbs/${shot.id}.png`, thumb),
        sha256: sha256(png),
        ...(halo ? { halo } : {}),
      });
    }
    frames.set(candidate.id, perShot);
    thumbs.set(candidate.id, perThumb);
    let motionRecord: unknown = { skipped: true };
    if (!options.skipMotion) {
      const plate = await loadPlate(motion.scene.background);
      const plan = shotPlan(
        motion,
        candidate,
        plate ? { href: dataUri(plate) } : undefined,
        options.compositing,
        false,
        options.motionGrammar,
      );
      const clip = await deps.voiceClip(
        styleFrameTiming(motion).voiceEndMs - styleFrameTiming(motion).voiceStartMs,
      );
      const mp4 = await deps.renderMotion(plan, clip, styleFrameTiming(motion).voiceStartMs);
      motionRecord = {
        id: motion.id,
        judge: motion.judge,
        durationMs: motion.durationMs,
        plate: !candidate.plateStyle ? "procedural" : plate ? "plate" : "fallback",
        file: await write(`${candidate.id}/${motion.id}.mp4`, mp4),
        sha256: sha256(mp4),
      };
    }
    candidateRecords.push({
      ...candidate,
      plates: plateRecords,
      shots: shotRecords,
      motion: motionRecord,
    });
  }

  // Blind review: one sheet per shot with the candidates in a seeded order; the key lives apart.
  const key: Record<string, Record<string, string>> = {};
  const sheets: string[] = [];
  const tile = { width: 540, height: 960 };
  for (const shot of stills) {
    const order = blindOrder(seedFor(blindSeed, shot.id), wanted.length);
    const tiles = order.map((index, position) => {
      const candidate = wanted[index] as StyleCandidate;
      const label = BLIND_LABELS[position] as string;
      const entry = key[shot.id] ?? {};
      entry[label] = candidate.id;
      key[shot.id] = entry;
      return { label, candidate };
    });
    sheets.push(
      await write(
        `review/blind/${shot.id}.png`,
        await deps.sheet(
          tiles.map(({ label, candidate }) => ({
            label,
            png: frames.get(candidate.id)?.get(shot.id) as Uint8Array,
          })),
          tile,
        ),
      ),
      await write(
        `review/blind/${shot.id}-160x284.png`,
        await deps.sheet(
          tiles.map(({ label, candidate }) => ({
            label,
            png: thumbs.get(candidate.id)?.get(shot.id) as Uint8Array,
          })),
          THUMB,
        ),
      ),
    );
  }
  // "Same show" contact sheet per candidate, blind-labelled with one permutation for the set.
  const contactOrder = blindOrder(seedFor(blindSeed, "contact"), wanted.length);
  key.contact = {};
  for (const [position, index] of contactOrder.entries()) {
    const candidate = wanted[index] as StyleCandidate;
    const label = BLIND_LABELS[position] as string;
    key.contact[label] = candidate.id;
    sheets.push(
      await write(
        `review/contact/${label}.png`,
        await deps.sheet(
          stills.map((shot) => ({
            label: "",
            png: thumbs.get(candidate.id)?.get(shot.id) as Uint8Array,
          })),
          THUMB,
        ),
      ),
    );
  }
  await write("review/key.json", `${JSON.stringify({ blindSeed, key }, null, 1)}\n`);

  const manifest = {
    harness: "style-frames",
    version: 1,
    generatedAt: deps.now().toISOString(),
    gitHead: await deps.gitHead(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      ...imageVersions(),
      ffmpeg: await deps.ffmpegVersion(),
    },
    frame: FRAME,
    thumb: THUMB,
    grades: GRADES,
    fixtures: {
      shots: STYLE_FRAME_SHOTS.length,
      stills: stills.length,
      motionTest: motion.id,
      captionWords: STYLE_FRAME_CAPTION_WORDS,
      cast: STYLE_FRAME_CAST.map((character) => character.key),
    },
    candidates: candidateRecords,
    compositing: options.compositing ?? null,
    motionGrammar: options.motionGrammar === true,
    review: { blindSeed, sheets, keyFile: "review/key.json" },
    ownerVisualApproval: "PENDING",
  };
  const manifestPath = await write("manifest.json", `${JSON.stringify(manifest, null, 1)}\n`);
  return { manifestPath, files };
};

/**
 * Profile-swap sheet (v2 slice 20): the motion test's entrance and point drawn with each acting
 * preset on the same character, one strip per preset, blind-labelled; the owner judges whether
 * the personalities read apart. Key in review/acting/key.json.
 */
export const renderActingSwap = async (
  deps: Pick<StyleFrameDeps, "rasterize" | "sheet">,
  options: Readonly<{ outDir: string; blindSeed?: number | undefined }>,
): Promise<readonly string[]> => {
  const motion = STYLE_FRAME_SHOTS.find((shot) => shot.id === MOTION_TEST_ID);
  if (!motion) throw new Error("style_motion_test_missing");
  const candidate = STYLE_CANDIDATES[0] as StyleCandidate;
  const presets = Object.entries(ACTING_PRESETS);
  const order = blindOrder(seedFor(options.blindSeed ?? 20260930, "acting"), presets.length);
  const files: string[] = [];
  const key: Record<string, string> = {};
  for (const [position, index] of order.entries()) {
    const [name, acting] = presets[index] as [string, ActingProfile];
    const label = BLIND_LABELS[position] as string;
    key[label] = name;
    const cast = STYLE_FRAME_CAST.map((character) =>
      character.key === "alex"
        ? {
            ...character,
            bible: {
              version: 1,
              role: "narrator" as const,
              body: { archetype: "average" as const, head: "circle" as const, scale: 1 },
              acting,
            },
          }
        : character,
    );
    const plan = planMotion({
      scenes: [styleFrameScene(motion)],
      timings: [styleFrameTiming(motion)],
      characters: cast,
      palette: DEFAULT_SCENE_PALETTE,
      captionWords: STYLE_FRAME_CAPTION_WORDS,
      durationMs: motion.durationMs,
      lineStyle: candidate.lineStyle,
      motionGrammar: true,
    });
    const point = plan.scenes[0]?.actors[0]?.actions.find((a) => a.action.type === "point_at");
    const at = point?.startMs ?? 3_000;
    const times = [250, 600, at + 60, at + 160, at + 330, at + 700];
    const tiles = [];
    for (const t of times)
      tiles.push({ label: "", png: await deps.rasterize(composeMotionFrame(plan, t)) });
    const path = join(options.outDir, `review/acting/${label}.png`);
    await mkdir(join(path, ".."), { recursive: true });
    // Larger than the 160x284 review thumbs: acting differences are small movements.
    await writeFile(path, await deps.sheet(tiles, { width: 270, height: 480 }));
    files.push(`review/acting/${label}.png`);
  }
  await writeFile(
    join(options.outDir, "review/acting/key.json"),
    `${JSON.stringify({ key, frames: "entrance 250 ms, 600 ms; point +60, +160, +330, +700 ms" }, null, 1)}\n`,
  );
  files.push("review/acting/key.json");
  return files;
};

/** Real dependencies: sharp for rasters and sheets, the motion renderer for the MP4. */
export const createStyleFrameDeps = (input: {
  platesDir: string;
  threads?: number | undefined;
}): StyleFrameDeps => {
  configureBundledFonts();
  const renderer = createStickmanMotionRenderer({
    timeoutMs: 300_000,
    ...(input.threads ? { threads: input.threads } : {}),
  });
  return {
    rasterize: rasterizeFrame,
    thumbnail: thumbnailFrame,
    sheet: tileSheet,
    postProcessPlate: async (plate, plan) => {
      const out = await postProcessPlate(plate.bytes, plan);
      return {
        bytes: out.bytes,
        mimeType: out.mimeType,
        provenance: { from: plate.provenance, postProcess: out.record },
      };
    },
    focalContrast: (withActors, withoutActors) => measureFocalContrast(withActors, withoutActors),
    gradePlate: async (plate, grade) => ({
      mimeType: "image/jpeg",
      provenance: {
        from: plate.provenance,
        grade,
        spec: GRADES[grade],
        note: "harness-only sharp grade",
      },
      bytes: await gradePlateImage(plate.bytes, GRADES[grade]),
    }),
    voiceClip: async (durationMs) => {
      const dir = await mkdtemp(join(tmpdir(), "style-frames-"));
      try {
        const path = join(dir, "voice.wav");
        await exec("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=180:duration=${durationMs / 1000},volume='if(lt(mod(t,0.45),0.35),1,0)':eval=frame`,
          "-ar",
          "24000",
          path,
        ]);
        return new Uint8Array(await readFile(path));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    renderMotion: async (plan, clip, voiceStartMs) =>
      (await renderer.render({ plan, voiceClips: [clip], voiceStartMs: [voiceStartMs] })).bytes,
    plates: {
      load: async (candidateId, background) => {
        for (const [ext] of [
          ["png", "image/png"],
          ["jpg", "image/jpeg"],
        ] as const) {
          const path = join(input.platesDir, candidateId, `${background}.${ext}`);
          const bytes = await readFile(path).catch(() => null);
          if (!bytes) continue;
          const provenance = await readFile(
            join(input.platesDir, candidateId, `${background}.json`),
            "utf8",
          )
            .then((text) => JSON.parse(text) as unknown)
            .catch(() => null);
          // The bytes decide the mime type: a mislabelled data URI is dropped by librsvg silently.
          return { bytes: new Uint8Array(bytes), mimeType: sniffImageMimeType(bytes), provenance };
        }
        return null;
      },
    },
    gitHead: async () =>
      await exec("git", ["rev-parse", "HEAD"])
        .then((r) => r.stdout.trim())
        .catch(() => "unknown"),
    ffmpegVersion: async () =>
      await exec("ffmpeg", ["-version"])
        .then((r) => r.stdout.split("\n")[0] ?? "")
        .catch(() => "unknown"),
    now: () => new Date(),
  };
};

/** Backgrounds the fixtures use, so `generate-plates` asks for exactly those. */
export const fixtureBackgrounds = (): readonly BackgroundId[] => [
  ...new Set(STYLE_FRAME_SHOTS.map((shot) => shot.scene.background)),
];

/**
 * Fills `<platesDir>/<candidateId>/` through the configured SceneGenerator (Workers AI or
 * SCENE_GENERATOR_CMD), one plate per fixture background, with the locked prompt and provenance.
 * Existing files are kept, so a run is resumable and a review can pin its plates.
 */
export const generatePlates = async (input: {
  platesDir: string;
  candidates?: readonly string[] | undefined;
  generate: (prompt: string) => Promise<
    Readonly<{
      bytes: Uint8Array;
      mimeType: "image/png" | "image/jpeg";
      model?: string;
      seed?: number;
      neurons: number;
      width: number;
      height: number;
    }>
  >;
  now: () => Date;
}): Promise<readonly string[]> => {
  const written: string[] = [];
  const wanted = STYLE_CANDIDATES.filter(
    (candidate) =>
      candidate.plateStyle &&
      (!input.candidates?.length || input.candidates.includes(candidate.id)),
  );
  for (const candidate of wanted) {
    const style = candidate.plateStyle;
    if (!style) continue;
    const dir = join(input.platesDir, candidate.id);
    await mkdir(dir, { recursive: true });
    for (const background of fixtureBackgrounds()) {
      const existing = await readFile(join(dir, `${background}.json`)).catch(() => null);
      if (existing) continue;
      const prompt = explainerBackgroundPrompt({
        setting: background,
        style,
        paletteHint: DEFAULT_SCENE_PALETTE.accent,
      });
      const image = await input.generate(prompt);
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await writeFile(join(dir, `${background}.${ext}`), image.bytes);
      await writeFile(
        join(dir, `${background}.json`),
        `${JSON.stringify(
          {
            candidate: candidate.id,
            background,
            style,
            prompt,
            promptVersion: EXPLAINER_BACKGROUND_PROMPT_VERSION,
            requestedSize: EXPLAINER_BACKGROUND_SIZE,
            model: image.model ?? "workers-ai:flux-1-schnell",
            seed: image.seed ?? null,
            neurons: image.neurons,
            width: image.width,
            height: image.height,
            sha256: sha256(image.bytes),
            generatedAt: input.now().toISOString(),
          },
          null,
          1,
        )}\n`,
      );
      written.push(`${candidate.id}/${background}.${ext}`);
    }
  }
  return written;
};

const USAGE =
  "usage: style-frames.js sam-plates [outDir] [platesDir] [--candidate=id] | acting-swap [outDir] [--seed=n] | render [outDir=style-frames-out] [platesDir=style-frames-plates] [--candidates=a,b] [--seed=n] [--stills-only] [--compositing=hypothesis|<file>] [--grammar] | generate-plates [platesDir=style-frames-plates] [--candidates=a,b]";

const flag = (args: readonly string[], name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const main = async (): Promise<void> => {
  const [command, ...rest] = process.argv.slice(2);
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  const candidates = flag(rest, "candidates")?.split(",").filter(Boolean);
  if (command === "render") {
    const [outDir = "style-frames-out", platesDir = "style-frames-plates"] = positional;
    const threads = process.env.RENDER_THREADS ? Number(process.env.RENDER_THREADS) : undefined;
    const seed = flag(rest, "seed");
    const compositingArg = flag(rest, "compositing");
    const compositing =
      compositingArg === undefined
        ? undefined
        : compositingArg === "hypothesis"
          ? COMPOSITING_HYPOTHESIS
          : readCompositingProfile(JSON.parse(await readFile(compositingArg, "utf8")));
    if (compositingArg !== undefined && !compositing)
      throw new Error("compositing_profile_invalid");
    const result = await renderStyleFrames(createStyleFrameDeps({ platesDir, threads }), {
      outDir,
      candidates,
      blindSeed: seed ? Number(seed) : undefined,
      skipMotion: rest.includes("--stills-only"),
      compositing: compositing ?? undefined,
      motionGrammar: rest.includes("--grammar"),
    });
    console.log(
      JSON.stringify({ outDir, files: result.files.length, manifest: result.manifestPath }),
    );
    return;
  }
  if (command === "sam-plates") {
    const [outDir = "sam-plates-out", platesDir = "style-frames-plates"] = positional;
    const files = await renderSamPlates(createStyleFrameDeps({ platesDir }), {
      outDir,
      candidateId: flag(rest, "candidate"),
      compositing: COMPOSITING_HYPOTHESIS,
    });
    console.log(JSON.stringify({ outDir, files }));
    return;
  }
  if (command === "acting-swap") {
    const [outDir = "style-frames-out"] = positional;
    const seed = flag(rest, "seed");
    const files = await renderActingSwap(createStyleFrameDeps({ platesDir: "unused" }), {
      outDir,
      blindSeed: seed ? Number(seed) : undefined,
    });
    console.log(JSON.stringify({ outDir, files }));
    return;
  }
  if (command === "generate-plates") {
    const [platesDir = "style-frames-plates"] = positional;
    const generator = sceneGeneratorFor(parseWorkerEnvironment(process.env));
    if (!generator) throw new Error("scene_generator_not_configured");
    const written = await generatePlates({
      platesDir,
      candidates,
      generate: (prompt) => generator.generate(prompt, EXPLAINER_BACKGROUND_SIZE),
      now: () => new Date(),
    });
    console.log(JSON.stringify({ platesDir, written }));
    return;
  }
  throw new Error(USAGE);
};

if (process.argv[1]?.endsWith("style-frames.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "style frames failed");
    process.exitCode = 1;
  });
}
