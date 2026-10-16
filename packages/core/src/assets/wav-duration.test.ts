import { describe, expect, it } from "vitest";
import { wavDurationMs } from "./wav-duration.js";

const u32le = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Builds a minimal 44-byte PCM WAV header (no LIST chunk) followed by `dataBytes` of samples. */
const pcmWav = (
  input: Readonly<{ byteRate: number; dataSize: number; riffSize?: number }>,
): Uint8Array => {
  const { byteRate, dataSize, riffSize = 36 + dataSize } = input;
  const bytes = [
    ...ascii("RIFF"),
    ...u32le(riffSize),
    ...ascii("WAVE"),
    ...ascii("fmt "),
    ...u32le(16),
    ...u16le(1), // PCM
    ...u16le(1), // mono
    ...u32le(24000), // sample rate
    ...u32le(byteRate),
    ...u16le(2), // block align
    ...u16le(16), // bits per sample
    ...ascii("data"),
    ...u32le(dataSize),
    ...new Array(Math.max(dataSize, 0)).fill(0),
  ];
  return new Uint8Array(bytes);
};

describe("wavDurationMs", () => {
  it("reads a standard PCM header", () => {
    const bytes = pcmWav({ byteRate: 24000 * 2, dataSize: 48000 });
    expect(wavDurationMs(bytes)).toBe(1000);
  });

  it("rejects a non-WAV buffer", () => {
    const bytes = new Uint8Array([...ascii("OggS"), 0, 0, 0, 0]);
    expect(() => wavDurationMs(bytes)).toThrow("wav_invalid");
  });

  it("finds the data chunk after a LIST chunk", () => {
    const byteRate = 24000 * 2;
    const dataSize = 48000;
    const listPayload = [...ascii("INFO"), ...ascii("ICMT"), ...u32le(4), ...ascii("test")];
    const bytes = new Uint8Array([
      ...ascii("RIFF"),
      ...u32le(36 + listPayload.length + dataSize),
      ...ascii("WAVE"),
      ...ascii("fmt "),
      ...u32le(16),
      ...u16le(1),
      ...u16le(1),
      ...u32le(24000),
      ...u32le(byteRate),
      ...u16le(2),
      ...u16le(16),
      ...ascii("LIST"),
      ...u32le(listPayload.length),
      ...listPayload,
      ...ascii("data"),
      ...u32le(dataSize),
      ...new Array(dataSize).fill(0),
    ]);
    expect(wavDurationMs(bytes)).toBe(1000);
  });

  it("clamps a streaming header's 0xFFFFFFFF data size to the bytes present", () => {
    const byteRate = 24000 * 2;
    const bytes = new Uint8Array([
      ...ascii("RIFF"),
      ...u32le(0xffffffff),
      ...ascii("WAVE"),
      ...ascii("fmt "),
      ...u32le(16),
      ...u16le(1),
      ...u16le(1),
      ...u32le(24000),
      ...u32le(byteRate),
      ...u16le(2),
      ...u16le(16),
      ...ascii("data"),
      ...u32le(0xffffffff),
      ...new Array(24000).fill(0),
    ]);
    expect(wavDurationMs(bytes)).toBe(500);
  });
});
