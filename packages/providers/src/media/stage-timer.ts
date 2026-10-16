/**
 * Stage accumulators for the stickman render (video slice 12, benchmark B1): one clock reading
 * at each stage boundary, summed per stage, so a render can report where its wall time went
 * without changing its output. Overhead is a few `performance.now()` calls per frame batch.
 */
export type RenderStage = "compose" | "raster" | "write" | "encode" | "mix" | "qa" | "concat";

export type RenderTimings = Readonly<{
  frames: number;
  /** SVG composition of every frame (core, synchronous). */
  composeMs: number;
  /** sharp rasterisation to raw RGB, wall time of each concurrent batch. */
  rasterMs: number;
  /** Time blocked writing raw frames into the encoder's stdin (back-pressure). */
  writeMs: number;
  /** From the last frame written until the encoder exits (its tail work). */
  encodeMs: number;
  /** Stream-copy concat of chunk videos; 0 for a single-pass render. */
  concatMs: number;
  /** Chunk videos the frame path was split into; 1 for a single-pass render. */
  chunks: number;
  /** Narration and SFX mux with loudness normalisation. */
  mixMs: number;
  /** ffprobe measurement and the technical quality gate. */
  qaMs: number;
  /** Whole render call, temp files included. */
  totalMs: number;
  /** frames / (compose + raster + write + encode); the frame path only. */
  framesPerSec: number;
}>;

export type StageTimer = Readonly<{
  mark(stage: RenderStage): void;
  stop(stage: RenderStage): void;
  time<T>(stage: RenderStage, work: () => Promise<T>): Promise<T>;
  read(): Readonly<Partial<Record<RenderStage, number>>>;
}>;

export const createStageTimer = (now: () => number = () => performance.now()): StageTimer => {
  const totals: Partial<Record<RenderStage, number>> = {};
  const open: Partial<Record<RenderStage, number>> = {};
  const stop = (stage: RenderStage): void => {
    const started = open[stage];
    if (started === undefined) throw new Error(`stage_timer_not_started:${stage}`);
    delete open[stage];
    totals[stage] = (totals[stage] ?? 0) + (now() - started);
  };
  return {
    mark: (stage) => {
      open[stage] = now();
    },
    stop,
    async time(stage, work) {
      open[stage] = now();
      try {
        return await work();
      } finally {
        stop(stage);
      }
    },
    read: () => ({ ...totals }),
  };
};

const tenth = (value: number): number => Math.round(value * 10) / 10;

export const summarizeTimings = (input: {
  frames: number;
  stages: Readonly<Partial<Record<RenderStage, number>>>;
  totalMs: number;
  chunks?: number;
}): RenderTimings => {
  const composeMs = tenth(input.stages.compose ?? 0);
  const rasterMs = tenth(input.stages.raster ?? 0);
  const writeMs = tenth(input.stages.write ?? 0);
  const encodeMs = tenth(input.stages.encode ?? 0);
  const framePathMs = composeMs + rasterMs + writeMs + encodeMs;
  return {
    frames: input.frames,
    composeMs,
    rasterMs,
    writeMs,
    encodeMs,
    concatMs: tenth(input.stages.concat ?? 0),
    chunks: input.chunks ?? 1,
    mixMs: tenth(input.stages.mix ?? 0),
    qaMs: tenth(input.stages.qa ?? 0),
    totalMs: tenth(input.totalMs),
    framesPerSec: framePathMs > 0 ? tenth((input.frames * 1000) / framePathMs) : 0,
  };
};
