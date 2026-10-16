import { describe, expect, it } from "vitest";
import { parseSourceTranscript } from "./source-transcript.js";

describe("parseSourceTranscript", () => {
  it("returns timed cues from WebVTT and preserves cue timing", () => {
    const result = parseSourceTranscript({
      format: "auto",
      text: "WEBVTT\n\n00:00:01.200 --> 00:00:02.500\nA clear answer.",
    });

    expect(result).toEqual({
      ok: true,
      format: "vtt",
      text: "WEBVTT\n\n00:00:01.200 --> 00:00:02.500\nA clear answer.",
      cues: [{ startMs: 1200, endMs: 2500, text: "A clear answer." }],
    });
  });

  it("parses SRT timestamps and accepts overlapping speaker cues", () => {
    const result = parseSourceTranscript({
      format: "srt",
      text: "1\n00:00:03,000 --> 00:00:05,000\nFirst speaker\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond speaker",
    });

    expect(result).toMatchObject({
      ok: true,
      format: "srt",
      cues: [
        { startMs: 3000, endMs: 5000, text: "First speaker" },
        { startMs: 4000, endMs: 6000, text: "Second speaker" },
      ],
    });
  });

  it("keeps plain transcript text untimed", () => {
    expect(parseSourceTranscript({ format: "auto", text: "  One line.\nAnother line.  " })).toEqual(
      {
        ok: true,
        format: "text",
        text: "One line.\nAnother line.",
        cues: [],
      },
    );
  });

  it.each([
    { format: "srt" as const, text: "00:00:03,000 --> 00:00:02,000\nBad range" },
    { format: "vtt" as const, text: "WEBVTT\n\n00:00:01.000 --> not-a-time\nBad cue" },
  ])("rejects malformed timed transcript cues", ({ format, text }) => {
    expect(parseSourceTranscript({ format, text })).toEqual({
      ok: false,
      error: "INVALID_CUES",
    });
  });

  it("rejects empty, oversized and excessive-cue input", () => {
    expect(parseSourceTranscript({ format: "auto", text: "  " })).toEqual({
      ok: false,
      error: "EMPTY",
    });
    expect(parseSourceTranscript({ format: "text", text: "x".repeat(120_001) })).toEqual({
      ok: false,
      error: "TOO_LARGE",
    });

    const tooManyCues = Array.from({ length: 5001 }, () => "00:00.0 --> 00:01.0\nx").join("\n\n");
    expect(parseSourceTranscript({ format: "vtt", text: `WEBVTT\n\n${tooManyCues}` })).toEqual({
      ok: false,
      error: "TOO_MANY_CUES",
    });
  });
});
