/**
 * Signal checks for a synthesized voice clip (16-bit or 32-bit float PCM WAV): level, clipping
 * and silence at the edges. Used as automatic QA by the TTS arena; dBFS is relative to full scale.
 */
export type WavAnalysis = Readonly<{
  sampleRate: number;
  channels: number;
  durationMs: number;
  peakDbfs: number;
  rmsDbfs: number;
  /** Share of samples at or above 0.999 of full scale. */
  clippingRatio: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
}>;

const ascii = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
/** Below this absolute level (about -50 dBFS) a sample counts as silence at the clip edges. */
const SILENCE = 0.003;
const dbfs = (value: number) => (value > 0 ? Math.round(20 * Math.log10(value) * 10) / 10 : -120);

export const analyzeWav = (bytes: Uint8Array): WavAnalysis => {
  if (bytes.length < 44 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE")
    throw new Error("wav_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      format = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    }
    if (id === "data") {
      const pcm16 = (format === 1 || format === 0xfffe) && bits === 16;
      const float32 = (format === 3 || format === 0xfffe) && bits === 32;
      if (!channels || !sampleRate || (!pcm16 && !float32))
        throw new Error("wav_format_unsupported");
      const start = offset + 8;
      const width = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - start) / (width * channels));
      const sample = (frame: number): number => {
        let peak = 0;
        for (let c = 0; c < channels; c += 1) {
          const at = start + (frame * channels + c) * width;
          const v = pcm16 ? view.getInt16(at, true) / 32768 : view.getFloat32(at, true);
          if (Math.abs(v) > Math.abs(peak)) peak = v;
        }
        return Math.abs(peak);
      };
      let peak = 0;
      let sumSquares = 0;
      let clipped = 0;
      let first = -1;
      let last = -1;
      for (let frame = 0; frame < frames; frame += 1) {
        const v = sample(frame);
        peak = Math.max(peak, v);
        sumSquares += v * v;
        if (v >= 0.999) clipped += 1;
        if (v > SILENCE) {
          if (first < 0) first = frame;
          last = frame;
        }
      }
      const ms = (n: number) => Math.round((n / sampleRate) * 1000);
      return {
        sampleRate,
        channels,
        durationMs: ms(frames),
        peakDbfs: dbfs(peak),
        rmsDbfs: dbfs(frames ? Math.sqrt(sumSquares / frames) : 0),
        clippingRatio: frames ? clipped / frames : 0,
        leadingSilenceMs: first < 0 ? ms(frames) : ms(first),
        trailingSilenceMs: last < 0 ? ms(frames) : ms(frames - 1 - last),
      };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("wav_invalid");
};
