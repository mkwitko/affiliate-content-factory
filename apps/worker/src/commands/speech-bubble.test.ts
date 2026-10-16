import { describe, expect, it } from "vitest";
import { BUBBLE, bubbleSvg, layoutBubble, obstaclesFrom, placeBubble } from "./speech-bubble.js";

const canvas = { w: 1080, h: 1350 } as const;
const band = { top: 945, bottom: 1107 } as const;
type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placeBubble", () => {
  it("sits near the face without touching it, the product, the text or the caption band", () => {
    const face = { x: 440, y: 300, w: 200, h: 200 };
    const product = { x: 650, y: 500, w: 300, h: 400 };
    const headline = { x: 65, y: 65, w: 700, h: 160 };
    const placed = placeBubble({
      canvas,
      size: { w: 360, h: 140 },
      avoid: [face, product, headline],
      band,
      speaker: { x: 540, y: 400 },
    });
    expect(placed).not.toBeNull();
    const box = placed?.box as Box;
    for (const other of [face, product, headline]) expect(overlaps(box, other)).toBe(false);
    expect(box.y + box.h <= band.top || box.y >= band.bottom).toBe(true);
    expect(box.x >= 0 && box.x + box.w <= canvas.w && box.y >= 0).toBe(true);
    // Near the speaker: its centre within 450 px of the face centre.
    expect(Math.hypot(box.x + box.w / 2 - 540, box.y + box.h / 2 - 400)).toBeLessThan(450);
    // The tail points at the face and stops short of it.
    const tip = placed?.tip as { x: number; y: number };
    expect(overlaps({ ...tip, w: 1, h: 1 }, face)).toBe(false);
    expect(Math.hypot(tip.x - 540, tip.y - 400)).toBeLessThan(
      Math.hypot(box.x + box.w / 2 - 540, box.y + box.h / 2 - 400),
    );
  });

  it("goes as high as it can without a speaker, and returns null when nothing is clear", () => {
    const headline = { x: 0, y: 0, w: 1080, h: 200 };
    const top = placeBubble({ canvas, size: { w: 360, h: 140 }, avoid: [headline], band });
    expect(top?.box.y).toBeLessThan(300);
    expect(top?.box.y).toBeGreaterThanOrEqual(200);
    expect(
      placeBubble({ canvas, size: { w: 360, h: 140 }, avoid: [{ x: 0, y: 0, ...canvas }], band }),
    ).toBeNull();
  });
});

describe("obstaclesFrom", () => {
  it("blocks faces and the product whole, a person's head only, and the drawn text", () => {
    const { avoid, speaker } = obstaclesFrom(
      [
        { kind: "person", box: { x: 100, y: 100, w: 400, h: 1000 } },
        { kind: "product", box: { x: 600, y: 600, w: 200, h: 200 } },
      ],
      [{ x: 10, y: 10, w: 50, h: 50 }],
    );
    expect(avoid).toEqual([
      { x: 100, y: 100, w: 400, h: 300 },
      { x: 600, y: 600, w: 200, h: 200 },
      { x: 10, y: 10, w: 50, h: 50 },
    ]);
    expect(speaker).toEqual({ x: 300, y: 250 });
    const withFace = obstaclesFrom(
      [
        { kind: "person", box: { x: 100, y: 100, w: 400, h: 1000 } },
        { kind: "face", box: { x: 200, y: 120, w: 100, h: 100 } },
      ],
      [],
    );
    expect(withFace.speaker).toEqual({ x: 250, y: 170 });
  });
});

describe("layoutBubble / bubbleSvg", () => {
  it("shrinks the text before giving up and escapes it in the SVG", () => {
    const line = "Cadê lugar pra toalha?";
    const big = layoutBubble({ canvas, text: line, avoid: [], band });
    expect(big?.lines.join(" ")).toBe(line);
    // A column one pixel narrower than the largest bubble.
    const wall = BUBBLE.margin + (big?.box.w ?? 0) - 1 + BUBBLE.gap;
    const cramped = layoutBubble({
      canvas,
      text: line,
      avoid: [{ x: wall, y: 0, w: 1080 - wall, h: 1350 }],
      band,
    });
    expect(cramped?.fontSize).toBeLessThan(big?.fontSize ?? 0);
    const svg = bubbleSvg(canvas, {
      box: { x: 10, y: 10, w: 300, h: 100 },
      tip: { x: 100, y: 200 },
      lines: ["A & <B>"],
      fontSize: 40,
    });
    expect(svg).toContain("A &amp; &lt;B&gt;");
    expect(svg).toContain('width="1080"');
  });
});
