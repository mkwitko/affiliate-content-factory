export type SourceTranscriptFormat = "auto" | "text" | "srt" | "vtt";

export type SourceTranscriptCue = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;

export type SourceTranscriptResult =
  | Readonly<{
      ok: true;
      format: Exclude<SourceTranscriptFormat, "auto">;
      text: string;
      cues: readonly SourceTranscriptCue[];
    }>
  | Readonly<{ ok: false; error: "EMPTY" | "TOO_LARGE" | "INVALID_CUES" | "TOO_MANY_CUES" }>;

const maxCharacters = 120_000;
const maxCues = 5_000;

const toMilliseconds = (stamp: string, separator: "." | ","): number | null => {
  const expression =
    separator === "."
      ? /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{1,3})$/
      : /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{1,3})$/;
  const match = expression.exec(stamp);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minuteValue = match[2];
  const secondValue = match[3];
  const millisecondValue = match[4];
  if (!minuteValue || !secondValue || !millisecondValue) return null;
  const minutes = Number(minuteValue);
  const seconds = Number(secondValue);
  const milliseconds = Number(millisecondValue.padEnd(3, "0"));
  const total = ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
  return Number.isSafeInteger(total) ? total : null;
};

const parseTimedCues = (
  text: string,
  format: "srt" | "vtt",
): readonly SourceTranscriptCue[] | null => {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const cues: SourceTranscriptCue[] = [];
  const timestamp =
    format === "srt"
      ? /^(\d{2,}:\d{2}:\d{2},\d{1,3})\s+-->\s+(\d{2,}:\d{2}:\d{2},\d{1,3})(?:\s+.*)?$/
      : /^(\d{2,}:)?\d{2}:\d{2}\.\d{1,3}\s+-->\s+(\d{2,}:)?\d{2}:\d{2}\.\d{1,3}(?:\s+.*)?$/;

  for (const block of blocks) {
    const lines = block.split("\n");
    const firstLine = lines[0];
    if (!firstLine) return null;
    if (format === "vtt" && /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(firstLine)) continue;
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex < 0) {
      if (format === "vtt" && firstLine.trim() === "WEBVTT") continue;
      return null;
    }

    const timeLine = lines[timeIndex]?.trim();
    if (!timeLine) return null;
    const matched = timestamp.exec(timeLine);
    if (!matched) return null;
    const startStamp = timeLine.split(/\s+-->\s+/)[0];
    const endStamp = timeLine.split(/\s+-->\s+/)[1]?.split(/\s+/)[0];
    if (!startStamp || !endStamp) return null;
    const startMs = toMilliseconds(startStamp, format === "srt" ? "," : ".");
    const endMs = toMilliseconds(endStamp, format === "srt" ? "," : ".");
    const cueText = lines
      .slice(timeIndex + 1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (startMs === null || endMs === null || endMs <= startMs || !cueText) return null;
    cues.push({ startMs, endMs, text: cueText });
  }
  return cues.length > 0 ? cues : null;
};

export const parseSourceTranscript = (input: {
  text: string;
  format: SourceTranscriptFormat;
}): SourceTranscriptResult => {
  const text = input.text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text) return { ok: false, error: "EMPTY" };
  if (text.length > maxCharacters) return { ok: false, error: "TOO_LARGE" };

  const format =
    input.format === "auto"
      ? /^WEBVTT(?:\s|$)/.test(text)
        ? "vtt"
        : /-->/.test(text)
          ? "srt"
          : "text"
      : input.format;
  if (format === "text") return { ok: true, format, text, cues: [] };

  const cues = parseTimedCues(text, format);
  if (!cues) return { ok: false, error: "INVALID_CUES" };
  if (cues.length > maxCues) return { ok: false, error: "TOO_MANY_CUES" };
  return { ok: true, format, text, cues };
};
