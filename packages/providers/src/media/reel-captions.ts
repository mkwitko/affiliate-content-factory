import type { ReelTimeline } from "@money-maker/core/assets/reel-timeline";
import type { ResolvedCaptionTheme } from "@money-maker/core/brand/caption-style";
import type { SpokenWord } from "@money-maker/core/assets/speech-synthesizer";

/**
 * Builds a word-by-word ASS caption track from a reel timeline: pure, no ffmpeg or IO, so it
 * can be unit tested directly. Words are grouped `groupSize` at a time, left to right, never
 * across slides; each group's active word is rendered in yellow, popping in, while the group is on screen,
 * and the last word of a group extends to the next group (or the slide end) so text never
 * flickers off between words.
 */
export type CaptionStyle = Readonly<{
  fontName?: string;
  fontSize?: number;
  marginV?: number;
  groupSize?: number;
  /** Opaque dark box behind each line, for light backgrounds (explainer scenes). */
  boxed?: boolean;
  /** A resolved caption theme; when present it replaces every other field. */
  theme?: ResolvedCaptionTheme;
}>;

const pad2 = (n: number): string => String(n).padStart(2, "0");

export const assTime = (ms: number): string => {
  const totalCentiseconds = Math.floor(ms / 10);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
};

export const escapeAssText = (text: string): string =>
  text.replace(/\{/g, "(").replace(/\}/g, ")").replace(/\\/g, "/").replace(/\n/g, " ");

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
};

/** The active word starts 15% larger and settles to full size over 150ms (times are relative
 * to the Dialogue line, which starts when the word is spoken). */
const POP_IN = "\\fscx115\\fscy115\\t(0,150,\\fscx100\\fscy100)";

const groupText = (group: readonly SpokenWord[], highlightIndex: number): string =>
  group
    .map((word, index) =>
      index === highlightIndex
        ? `{\\c&H00FFFF&${POP_IN}}${escapeAssText(word.text)}{\\c&HFFFFFF&\\fscx100\\fscy100}`
        : escapeAssText(word.text),
    )
    .join(" ");

/** "#RRGGBB" to the BGR hex ASS wants. */
const bgr = (hex: string): string =>
  `${hex.slice(5, 7)}${hex.slice(3, 5)}${hex.slice(1, 3)}`.toUpperCase();

const themedAss = (timeline: ReelTimeline, theme: ResolvedCaptionTheme): string => {
  const text = (value: string) => escapeAssText(theme.uppercase ? value.toUpperCase() : value);
  const base = bgr(theme.baseColor);
  const highlight = bgr(theme.highlightColor);
  const karaoke = theme.highlightMode === "karaoke_fill";
  const surface = bgr(theme.surfaceColor);
  // Box draws OutlineColour as the box. It must be opaque: libass draws one box per styled run
  // (the highlighted word is its own run), and translucent boxes darken where they overlap,
  // which reads as a stray mark behind the spoken word.
  const [outlineColour, backColour, borderStyle] =
    theme.surface === "box"
      ? [`&H00${surface}`, `&H00${surface}`, "3,14,0"]
      : theme.surface === "shadow"
        ? [`&H00${surface}`, `&H60${surface}`, "1,0,3"]
        : [`&H00${surface}`, `&H80${surface}`, "1,4,2"];
  const alignment = theme.position === "center" ? 5 : theme.position === "lower_third" ? 1 : 2;
  // Karaoke sweeps from SecondaryColour to PrimaryColour.
  const primary = karaoke ? highlight : base;
  const secondary = karaoke ? base : "0000FF";

  const dialogueLines: string[] = [];
  for (const slide of timeline.slides) {
    const groups = chunk(slide.words, theme.maxWords);
    const slideEndMs = Math.round((slide.startSec + slide.durationSec) * 1000);
    groups.forEach((group, groupIndex) => {
      const nextGroupStartMs = groups[groupIndex + 1]?.[0]?.startMs ?? slideEndMs;
      if (karaoke) {
        const words = group.map((word, index) => {
          const end = group[index + 1]?.startMs ?? nextGroupStartMs;
          return `{\\kf${Math.max(1, Math.round((end - word.startMs) / 10))}}${text(word.text)}`;
        });
        dialogueLines.push(
          `Dialogue: 0,${assTime(group[0]?.startMs ?? 0)},${assTime(nextGroupStartMs)},Default,,0,0,0,,${words.join(" ")}`,
        );
        return;
      }
      group.forEach((word, wordIndex) => {
        const endMs = group[wordIndex + 1]?.startMs ?? nextGroupStartMs;
        const line = group
          .map((w, index) => {
            if (index !== wordIndex || theme.highlightMode === "none") return text(w.text);
            const pop = theme.highlightMode === "color_pop" ? POP_IN : "";
            return `{\\c&H${highlight}&${pop}}${text(w.text)}{\\c&H${base}&\\fscx100\\fscy100}`;
          })
          .join(" ");
        dialogueLines.push(
          `Dialogue: 0,${assTime(word.startMs)},${assTime(endMs)},Default,,0,0,0,,${line}`,
        );
      });
    });
  }

  const [resX, resY] = theme.canvas === "landscape" ? [1920, 1080] : [1080, 1920];
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${theme.font},${theme.size},&H00${primary},&H00${secondary},${outlineColour},${backColour},-1,0,0,0,100,100,0,0,${borderStyle},${alignment},80,${theme.marginR},${theme.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;
  return [header, ...dialogueLines].join("\n");
};

/** Returns the full ASS file text, or null when the timeline carries no words at all. */
export const buildCaptionAss = (timeline: ReelTimeline, style?: CaptionStyle): string | null => {
  if (timeline.slides.every((slide) => slide.words.length === 0)) return null;
  if (style?.theme) return themedAss(timeline, style.theme);

  const fontName = style?.fontName ?? "Inter";
  const fontSize = style?.fontSize ?? 64;
  const marginV = style?.marginV ?? 576;
  const groupSize = style?.groupSize ?? 3;
  // BorderStyle 3 draws OutlineColour as a box (padding = Outline); 0x30 alpha is ~80% opaque.
  const border = style?.boxed ? "&H30161616,&H30161616" : "&H00000000,&H80000000";
  const borderStyle = style?.boxed ? "3,14,0" : "1,4,2";

  const dialogueLines: string[] = [];
  for (const slide of timeline.slides) {
    const groups = chunk(slide.words, groupSize);
    const slideEndMs = Math.round((slide.startSec + slide.durationSec) * 1000);
    groups.forEach((group, groupIndex) => {
      const nextGroupStartMs = groups[groupIndex + 1]?.[0]?.startMs ?? slideEndMs;
      group.forEach((word, wordIndex) => {
        const endMs = group[wordIndex + 1]?.startMs ?? nextGroupStartMs;
        const text = groupText(group, wordIndex);
        dialogueLines.push(
          `Dialogue: 0,${assTime(word.startMs)},${assTime(endMs)},Default,,0,0,0,,${text}`,
        );
      });
    });
  }

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},&H00FFFFFF,&H000000FF,${border},-1,0,0,0,100,100,0,0,${borderStyle},2,80,80,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  return [header, ...dialogueLines].join("\n");
};
