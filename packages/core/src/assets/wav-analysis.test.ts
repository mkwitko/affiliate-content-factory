import { describe, expect, it } from "vitest";
import { analyzeWav } from "./wav-analysis.js";

const wav16 = (samples: readonly number[], rate = 1000): Uint8Array => {
  const data = samples.length * 2;
  const b = new DataView(new ArrayBuffer(44 + data));
  const text = (at: number, s: string) => {
    for (const [i, c] of [...s].entries()) b.setUint8(at + i, c.charCodeAt(0));
  };
  text(0, "RIFF");
  b.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  b.setUint32(16, 16, true);
  b.setUint16(20, 1, true);
  b.setUint16(22, 1, true);
  b.setUint32(24, rate, true);
  b.setUint32(28, rate * 2, true);
  b.setUint16(32, 2, true);
  b.setUint16(34, 16, true);
  text(36, "data");
  b.setUint32(40, data, true);
  for (const [i, s] of samples.entries()) b.setInt16(44 + i * 2, Math.round(s * 32767), true);
  return new Uint8Array(b.buffer);
};

describe("analyzeWav", () => {
  it("measures level, clipping and edge silence", () => {
    const samples = [...Array(100).fill(0), ...Array(800).fill(0.5), 1, 1, ...Array(98).fill(0)];
    const a = analyzeWav(wav16(samples));
    expect(a).toMatchObject({ sampleRate: 1000, channels: 1, durationMs: 1000 });
    expect(a.leadingSilenceMs).toBe(100);
    expect(a.trailingSilenceMs).toBe(98);
    expect(a.clippingRatio).toBeCloseTo(2 / 1000, 5);
    expect(a.peakDbfs).toBeCloseTo(0, 0);
    expect(a.rmsDbfs).toBeLessThan(-6);
  });

  it("refuses something that is not a WAV", () => {
    expect(() => analyzeWav(new Uint8Array(50))).toThrow("wav_invalid");
  });
});
