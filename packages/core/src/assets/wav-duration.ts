/**
 * Reads the duration of a RIFF/WAVE PCM buffer from its header, without decoding samples.
 * Streaming encoders (Kokoro) write RIFF and data chunk sizes of 0xFFFFFFFF because they don't
 * know the final length up front; in that case we trust the bytes actually present instead.
 */
const ascii = (bytes: Uint8Array, at: number): string =>
  String.fromCharCode(...bytes.subarray(at, at + 4));

export const wavDurationMs = (bytes: Uint8Array): number => {
  if (bytes.length < 44 || ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "WAVE") {
    throw new Error("wav_invalid");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") byteRate = view.getUint32(offset + 16, true);
    if (id === "data") {
      if (byteRate === 0) throw new Error("wav_invalid");
      const present = Math.min(size, bytes.length - (offset + 8));
      return Math.round((present / byteRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("wav_invalid");
};
