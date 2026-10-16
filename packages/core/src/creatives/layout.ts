import type { Zone } from "./templates.js";
import type { PixelBox } from "./creative-renderer.js";

export const zoneToPixels = (zone: Zone, canvas: { w: number; h: number }): PixelBox => {
  const x = Math.round(zone.x * canvas.w);
  const y = Math.round(zone.y * canvas.h);
  return { x, y, w: Math.round(zone.w * canvas.w), h: Math.round(zone.h * canvas.h) };
};

export const wrapText = (text: string, maxChars: number): readonly string[] => {
  if (!Number.isInteger(maxChars) || maxChars < 1) return [];
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

export const fitHeadline = (
  text: string,
  box: PixelBox,
  maxLines: number,
): { fontSize: number; lines: readonly string[] } | null => {
  const canvasWidth = Math.round(box.w / 0.84);
  for (const ratio of [0.085, 0.075, 0.065]) {
    const fontSize = Math.round(canvasWidth * ratio);
    const maxChars = Math.max(1, Math.floor(box.w / (fontSize * 0.48)));
    const lines = wrapText(text, maxChars);
    if (
      lines.length <= maxLines &&
      lines.every((line) => line.length <= maxChars) &&
      lines.length * fontSize * 1.08 <= box.h
    )
      return { fontSize, lines };
  }
  return null;
};

export const placeProduct = (
  product: { w: number; h: number },
  zone: PixelBox,
  surfaceY: number,
  anchor: "left" | "center" | "right",
): PixelBox => {
  const scale = Math.min(1, (zone.w * 0.92) / product.w, (zone.h * 0.92) / product.h);
  const w = Math.ceil(product.w * scale);
  const h = Math.ceil(product.h * scale);
  const x =
    anchor === "left"
      ? zone.x
      : anchor === "right"
        ? zone.x + zone.w - w
        : Math.round(zone.x + (zone.w - w) / 2);
  const y = Math.min(surfaceY - h, zone.y + zone.h - h);
  return { x, y, w, h };
};

export type LayoutVerdict = Readonly<
  { ok: true } | { ok: false; reason: "headline_unfit" | "zone_overflow" | "mark_missing" }
>;
export const judgeLayout = (
  boxes: readonly PixelBox[],
  canvas: { w: number; h: number },
  safeMargin: number,
): LayoutVerdict => {
  if (boxes.length === 0) return { ok: false, reason: "mark_missing" };
  const marginX = canvas.w * safeMargin;
  const marginY = canvas.h * safeMargin;
  if (
    boxes.some(
      (box) =>
        box.x < marginX ||
        box.y < marginY ||
        box.x + box.w > canvas.w - marginX ||
        box.y + box.h > canvas.h - marginY,
    )
  )
    return { ok: false, reason: "zone_overflow" };
  return { ok: true };
};
