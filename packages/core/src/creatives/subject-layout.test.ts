import { describe, expect, it } from "vitest";
import {
  chooseSubjectLayout,
  type MeasuredBlock,
  type PixelSubject,
  subjectsOnCanvas,
} from "./subject-layout.js";

// 1080x1350 feed, 64 px margins: text area x 64..1016, y 70..1270.
const area = { x: 64, y: 70, w: 952, h: 1200 };
/** Top stack 300 px tall at full width (taller in a column); bottom stack 320 px. */
const measure = (block: "top" | "bottom", width: number, scale: number): MeasuredBlock => {
  const narrow = width < area.w;
  const h = Math.round((block === "top" ? (narrow ? 420 : 300) : narrow ? 400 : 320) * scale);
  const w = Math.round(width * 0.9);
  return { w, h, items: [{ x: 0, y: 0, w, h }] };
};
const run = (subjects: readonly PixelSubject[]) =>
  chooseSubjectLayout({ area, gap: 24, subjects, measure });

describe("chooseSubjectLayout", () => {
  it("keeps the default placements at full size when no subject is in the way", () => {
    const layout = run([{ kind: "face", box: { x: 500, y: 500, w: 150, h: 150 } }]);
    expect(layout).toMatchObject({
      top: { placement: "top", scale: 1, card: false, box: { y: 70 } },
      bottom: { placement: "bottom", scale: 1 },
      collisions: [],
    });
  });

  it("moves the headline off a face at the top", () => {
    const layout = run([{ kind: "face", box: { x: 450, y: 150, w: 180, h: 180 } }]);
    expect(layout?.collisions).toEqual([]);
    expect(layout?.top.placement).not.toBe("top");
    const top = layout?.top.box;
    // The headline stack no longer touches the face.
    expect(top && (top.y > 330 || top.x + top.w < 450 || top.x > 630)).toBe(true);
  });

  it("allows a sliver of the product but never a head", () => {
    // Product barely under the bottom stack (< 5% of its area).
    const sliver = run([{ kind: "product", box: { x: 600, y: 1255, w: 300, h: 400 } }]);
    expect(sliver?.bottom.placement).toBe("bottom");
    expect(sliver?.collisions).toEqual([]);
    // A person whose head and shoulders sit where the headline goes.
    const person = run([{ kind: "person", box: { x: 64, y: 100, w: 952, h: 700 } }]);
    expect(person?.top.placement).not.toBe("top");
    expect(person?.collisions).toEqual([]);
  });

  it("falls back to a white headline card at the smallest scale and reports what still collides", () => {
    const everywhere = [{ kind: "face", box: { x: 0, y: 0, w: 1080, h: 1350 } }] as const;
    const layout = run(everywhere);
    expect(layout?.top).toMatchObject({ card: true, scale: 0.8 });
    expect(layout?.bottom.scale).toBe(0.8);
    expect(layout?.collisions.map((hit) => [hit.block, hit.kind])).toEqual([
      ["top", "face"],
      ["bottom", "face"],
    ]);
  });

  it("returns null when nothing fits the area", () => {
    expect(
      chooseSubjectLayout({
        area,
        gap: 24,
        subjects: [],
        measure: () => ({ w: 10, h: 5000, items: [] }),
      }),
    ).toBeNull();
  });
});

describe("subjectsOnCanvas", () => {
  it("maps 0..1000 boxes through a cover crop", () => {
    // Same aspect: plain scaling.
    expect(
      subjectsOnCanvas(
        [{ kind: "face", box: [0, 0, 500, 500] }],
        { w: 512, h: 640 },
        { w: 1080, h: 1350 },
      ),
    ).toEqual([{ kind: "face", box: { x: 0, y: 0, w: 540, h: 675 } }]);
    // 512x896 story on 1080x1920: scaled by 1080/512 vertically wins, sides cropped.
    const [mapped] = subjectsOnCanvas(
      [{ kind: "face", box: [0, 0, 1000, 1000] }],
      { w: 512, h: 896 },
      { w: 1080, h: 1920 },
    );
    expect(mapped?.box).toMatchObject({ x: 0, y: 0, w: 1080, h: 1920 });
  });
  it("maps a feed scene framed uncropped in the middle of a story", () => {
    // 512x640 at 1080 wide is 1350 tall, centred: top at (1920 - 1350) / 2 = 285.
    const [mapped] = subjectsOnCanvas(
      [{ kind: "face", box: [0, 0, 1000, 1000] }],
      { w: 512, h: 640 },
      { w: 1080, h: 1920 },
      "width",
    );
    expect(mapped?.box).toMatchObject({ x: 0, y: 285, w: 1080, h: 1350 });
  });
});
