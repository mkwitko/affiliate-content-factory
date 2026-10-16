import { describe, expect, it } from "vitest";
import {
  parseYouTubeDurationSeconds,
  parseYouTubeSourceCollection,
  parseYouTubeVideoId,
} from "./youtube-discovery.js";

describe("YouTube discovery values", () => {
  it("parses ISO-8601 video durations into seconds", () => {
    expect(parseYouTubeDurationSeconds("PT1H2M3S")).toBe(3723);
    expect(parseYouTubeDurationSeconds("PT45S")).toBe(45);
  });

  it("rejects malformed or empty durations", () => {
    expect(parseYouTubeDurationSeconds("P1D")).toBeNull();
    expect(parseYouTubeDurationSeconds("PT")).toBeNull();
  });

  it.each([
    "https://www.youtube.com/watch?v=abcdefghijk&t=30",
    "https://youtu.be/abcdefghijk?si=abc",
    "https://m.youtube.com/shorts/abcdefghijk",
    "https://www.youtube-nocookie.com/embed/abcdefghijk",
  ])("resolves a supported YouTube video URL: %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBe("abcdefghijk");
  });

  it.each([
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "https://example.com/watch?v=abcdefghijk",
    "https://www.youtube.com/playlist?list=abcdefghijk",
    "https://www.youtube.com/watch?v=too-short",
    "javascript:alert(1)",
  ])("rejects non-video or untrusted URLs: %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
  });

  it.each([
    [
      "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
      { kind: "channel", id: "UCabcdefghijklmnopqrstuv", lookup: "id" },
    ],
    [
      "https://youtube.com/@creator.handle",
      { kind: "channel", id: "creator.handle", lookup: "handle" },
    ],
    [
      "https://www.youtube.com/playlist?list=PL1234567890",
      { kind: "playlist", id: "PL1234567890", lookup: "id" },
    ],
  ] as const)("resolves a supported YouTube collection URL: %s", (url, expected) => {
    expect(parseYouTubeSourceCollection(url)).toEqual(expected);
  });

  it.each([
    "https://youtube.com.evil.test/channel/UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/c/creator",
    "https://www.youtube.com/playlist?list=bad",
    "http://www.youtube.com/@creatorhandle",
  ])("rejects unsupported or untrusted collection URL: %s", (url) => {
    expect(parseYouTubeSourceCollection(url)).toBeNull();
  });
});
