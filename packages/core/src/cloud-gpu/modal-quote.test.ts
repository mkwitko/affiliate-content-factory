import { describe, expect, it } from "vitest";
import { CLOUD_GPU_PILOT_BUDGET, quoteBrlMinor } from "../costs/generation-budget.js";
import { type ModalShape, modalMeteredMinor, modalQuote } from "./modal-quote.js";

const now = new Date("2026-10-15T12:00:00Z");
const fx = { brlPerUsd: 5.6, source: "bcb-ptax", at: now };
const shape = (gpu: ModalShape["gpu"]): ModalShape => ({
  gpu,
  cpuCores: 4,
  memoryGiB: 32,
  timeoutSeconds: 600,
  coldStartSeconds: 240,
});
const brl = (gpu: ModalShape["gpu"]) =>
  quoteBrlMinor(modalQuote({ shape: shape(gpu), model: "m", revision: "r", fx, now }));

describe("modalQuote", () => {
  it("prices timeout plus cold start with FX and margin, rounding up", () => {
    // (2.50 + 4 x 0.0473 + 32 x 0.008) $/h x 840 s = 68.74 cents -> 69; x 5.6 x 1.10 -> 426.
    expect(
      modalQuote({ shape: shape("A100-80GB"), model: "m", revision: "r", fx, now }),
    ).toMatchObject({
      provider: "modal",
      sourceCurrency: "USD",
      sourceMinor: 69,
      expiresAt: new Date(now.getTime() + 600_000),
    });
    expect(brl("A100-80GB")).toBe(426);
  });

  it("meters reported seconds plus cold start, capped at the timeout", () => {
    expect(modalMeteredMinor(shape("A100-80GB"), 300)).toBe(45);
    expect(modalMeteredMinor(shape("A100-80GB"), 99_999)).toBe(69);
    expect(modalMeteredMinor(shape("A100-80GB"), -5)).toBe(20);
  });
});
