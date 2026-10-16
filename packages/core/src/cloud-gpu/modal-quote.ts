import type { GenerationQuote } from "../costs/generation-budget.js";

/**
 * Modal worst-case pricing for one clip. Rates from `modal billing rates` read on 2026-10-09
 * (USD, per second billing); re-read them before changing the GPU. The quote prices the function's
 * hard timeout plus a cold-start allowance (image start, weights load), so a run can never cost
 * more than the reservation unless Modal changes its prices.
 */
export const MODAL_RATES = {
  readAt: "2026-10-09",
  gpuUsdPerHour: {
    T4: 0.59,
    L4: 0.8,
    A10G: 1.1,
    L40S: 1.95,
    "A100-40GB": 2.1,
    "A100-80GB": 2.5,
    H100: 3.95,
  },
  cpuUsdPerCoreHour: 0.0473,
  memoryUsdPerGiBHour: 0.008,
} as const;
export type ModalGpu = keyof typeof MODAL_RATES.gpuUsdPerHour;
export const isModalGpu = (value: string): value is ModalGpu => value in MODAL_RATES.gpuUsdPerHour;

/** IOF on a foreign card purchase, card spread and FX drift between quote and charge. */
export const CLOUD_GPU_TAX_MARGIN_BPS = 1_000;
const QUOTE_TTL_MS = 10 * 60 * 1000;

export type ModalShape = Readonly<{
  gpu: ModalGpu;
  cpuCores: number;
  memoryGiB: number;
  /** The deployed function's timeout. */
  timeoutSeconds: number;
  coldStartSeconds: number;
}>;

const usdPerSecond = (shape: ModalShape) =>
  (MODAL_RATES.gpuUsdPerHour[shape.gpu] +
    MODAL_RATES.cpuUsdPerCoreHour * shape.cpuCores +
    MODAL_RATES.memoryUsdPerGiBHour * shape.memoryGiB) /
  3600;

export const modalQuote = (input: {
  shape: ModalShape;
  model: string;
  revision: string;
  fx: Readonly<{ brlPerUsd: number; source: string; at: Date }>;
  now: Date;
}): GenerationQuote => ({
  provider: "modal",
  model: input.model,
  revision: input.revision,
  sourceCurrency: "USD",
  sourceMinor: Math.ceil(
    usdPerSecond(input.shape) * (input.shape.timeoutSeconds + input.shape.coldStartSeconds) * 100,
  ),
  fxRate: input.fx.brlPerUsd,
  fxSource: input.fx.source,
  fxAt: input.fx.at,
  taxMarginBps: CLOUD_GPU_TAX_MARGIN_BPS,
  quotedAt: input.now,
  expiresAt: new Date(input.now.getTime() + QUOTE_TTL_MS),
});

/**
 * Metered USD cents for a finished run: the seconds the function reported plus the cold-start
 * allowance, never more than the quote. An estimate until reconciled with `modal billing report`.
 */
export const modalMeteredMinor = (shape: ModalShape, billedSeconds: number): number =>
  Math.ceil(
    usdPerSecond(shape) *
      (Math.min(Math.max(0, billedSeconds), shape.timeoutSeconds) + shape.coldStartSeconds) *
      100,
  );
