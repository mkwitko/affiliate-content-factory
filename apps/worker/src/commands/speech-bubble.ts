import type { PixelBox } from "@money-maker/core/creatives/creative-renderer";
import { wrapText } from "@money-maker/core/creatives/layout";
import type { PixelSubject } from "@money-maker/core/creatives/subject-layout";

/**
 * Comic speech bubble for the Reel preview frames: one short character line, placed by a pure
 * grid search so it stays off faces, heads, the product, the drawn text and the caption band,
 * with its tail pointing at the speaker. Pixel units on the rendered frame.
 */
export const BUBBLE = Object.freeze({
  /** Distance from the frame edge. */
  margin: 40,
  /** Clearance around every obstacle; larger than `tail`, so the tail never reaches one. */
  gap: 36,
  tail: 30,
  step: 10,
  fontSizes: Object.freeze([52, 44, 36]),
  maxChars: 20,
  /** Head and shoulders: the top share of a person box (same rule as the text layout). */
  headShare: 0.3,
  /** Bubbles read better above or beside the speaker than below the face. */
  belowPenalty: 250,
});

type Point = Readonly<{ x: number; y: number }>;
type Size = Readonly<{ w: number; h: number }>;
type Band = Readonly<{ top: number; bottom: number }>;
export type PlacedBubble = Readonly<{ box: PixelBox; tip: Point }>;
export type BubbleLayout = PlacedBubble & Readonly<{ lines: readonly string[]; fontSize: number }>;

/** Faces and the product block whole, a person only at the head; the first face speaks. */
export const obstaclesFrom = (
  subjects: readonly PixelSubject[],
  drawn: readonly PixelBox[],
): { avoid: PixelBox[]; speaker?: Point } => {
  const head = (box: PixelBox): PixelBox => ({ ...box, h: box.h * BUBBLE.headShare });
  const avoid = [...subjects.map((s) => (s.kind === "person" ? head(s.box) : s.box)), ...drawn];
  const face = subjects.find((s) => s.kind === "face");
  const person = subjects.find((s) => s.kind === "person");
  const speaker = face
    ? { x: face.box.x + face.box.w / 2, y: face.box.y + face.box.h / 2 }
    : person
      ? {
          x: person.box.x + person.box.w / 2,
          y: person.box.y + (person.box.h * BUBBLE.headShare) / 2,
        }
      : undefined;
  return { avoid, ...(speaker ? { speaker } : {}) };
};

const clear = (box: PixelBox, avoid: readonly PixelBox[]): boolean =>
  avoid.every(
    (a) =>
      box.x >= a.x + a.w + BUBBLE.gap ||
      a.x >= box.x + box.w + BUBBLE.gap ||
      box.y >= a.y + a.h + BUBBLE.gap ||
      a.y >= box.y + box.h + BUBBLE.gap,
  );

/** Where the ray from the box centre towards `towards` leaves the box. */
const edgeTowards = (box: PixelBox, towards: Point): { edge: Point; dir: Point } => {
  const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const len = Math.hypot(towards.x - c.x, towards.y - c.y) || 1;
  const dir = { x: (towards.x - c.x) / len, y: (towards.y - c.y) / len };
  const t = Math.min(
    dir.x ? box.w / 2 / Math.abs(dir.x) : Number.POSITIVE_INFINITY,
    dir.y ? box.h / 2 / Math.abs(dir.y) : Number.POSITIVE_INFINITY,
  );
  return { edge: { x: c.x + dir.x * t, y: c.y + dir.y * t }, dir };
};

/**
 * Closest clear spot to the speaker (above it preferred); without one, as high as possible.
 * The bubble stays wholly above the caption band. Null when no spot is clear.
 */
export const placeBubble = (
  input: Readonly<{
    canvas: Size;
    size: Size;
    avoid: readonly PixelBox[];
    band: Band;
    speaker?: Point;
  }>,
): PlacedBubble | null => {
  const { canvas, size, speaker } = input;
  const target = speaker ?? { x: canvas.w / 2, y: 0 };
  let best: PixelBox | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const maxY = Math.min(input.band.top, canvas.h - BUBBLE.margin) - size.h;
  const maxX = canvas.w - BUBBLE.margin - size.w;
  for (let y = BUBBLE.margin; y <= maxY; y += BUBBLE.step) {
    for (let x = BUBBLE.margin; x <= maxX; x += BUBBLE.step) {
      const box = { x, y, w: size.w, h: size.h };
      if (!clear(box, input.avoid)) continue;
      const cx = x + size.w / 2;
      const cy = y + size.h / 2;
      const score =
        Math.hypot(cx - target.x, cy - target.y) +
        (speaker && cy > speaker.y ? BUBBLE.belowPenalty : 0);
      if (score < bestScore) {
        bestScore = score;
        best = box;
      }
    }
  }
  if (!best) return null;
  const { edge, dir } = edgeTowards(best, speaker ?? { x: best.x + best.w / 2, y: canvas.h });
  return {
    box: best,
    tip: {
      x: Math.round(edge.x + dir.x * BUBBLE.tail),
      y: Math.round(edge.y + dir.y * BUBBLE.tail),
    },
  };
};

/** Sizes the bubble for `text`, trying smaller type before giving up. */
export const layoutBubble = (
  input: Readonly<{
    canvas: Size;
    text: string;
    avoid: readonly PixelBox[];
    band: Band;
    speaker?: Point;
  }>,
): BubbleLayout | null => {
  const lines = wrapText(input.text, BUBBLE.maxChars);
  const longest = Math.max(...lines.map((line) => line.length));
  for (const fontSize of BUBBLE.fontSizes) {
    const size = {
      w: Math.ceil(longest * fontSize * 0.58 + fontSize * 1.6),
      h: Math.ceil(lines.length * fontSize * 1.2 + fontSize),
    };
    const placed = placeBubble({ ...input, size });
    if (placed) return { ...placed, lines, fontSize };
  }
  return null;
};

const esc = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );

/** White bubble with a dark outline and tail; Inter is registered by the creative renderer. */
export const bubbleSvg = (canvas: Size, bubble: BubbleLayout): string => {
  const { box, tip, lines, fontSize } = bubble;
  const { edge, dir } = edgeTowards(box, tip);
  const half = fontSize * 0.35;
  // The tail base sits a little inside the box so the fill hides the seam.
  const base = { x: edge.x - dir.x * half, y: edge.y - dir.y * half };
  const tail = [
    `${base.x - dir.y * half},${base.y + dir.x * half}`,
    `${tip.x},${tip.y}`,
    `${base.x + dir.y * half},${base.y - dir.x * half}`,
  ].join(" ");
  const rx = Math.min(box.h / 2, 44);
  const shapes = `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="${rx}"/><polygon points="${tail}"/>`;
  const text = lines
    .map(
      (line, i) =>
        `<text x="${box.x + box.w / 2}" y="${Math.round(box.y + fontSize * 0.5 + fontSize * 0.92 + i * fontSize * 1.2)}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="${fontSize}" fill="#1d1d1f">${esc(line)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.w}" height="${canvas.h}"><g fill="#1d1d1f" stroke="#1d1d1f" stroke-width="10" stroke-linejoin="round">${shapes}</g><g fill="#fff">${shapes}</g>${text}</svg>`;
};
