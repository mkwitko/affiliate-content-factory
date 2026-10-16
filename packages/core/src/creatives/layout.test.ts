import { describe, expect, it } from "vitest";
import { fitHeadline, judgeLayout, placeProduct, wrapText, zoneToPixels } from "./layout.js";

describe("creative layout", () => {
  it("wraps on word boundaries", () => {
    expect(wrapText("Seu notebook na altura certa", 14)).toEqual([
      "Seu notebook",
      "na altura",
      "certa",
    ]);
  });
  it("shrinks headlines and rejects text that cannot fit", () => {
    const box = { x: 86, y: 135, w: 907, h: 216 };
    expect(fitHeadline("Seu notebook na altura certa", box, 2)?.fontSize).toBe(92);
    expect(fitHeadline("x".repeat(60), box, 2)).toBeNull();
  });
  it("rests product on surface while preserving aspect ratio", () => {
    const box = placeProduct(
      { w: 1000, h: 1200 },
      { x: 86, y: 405, w: 907, h: 621 },
      1026,
      "center",
    );
    expect(box.y + box.h).toBe(1026);
    expect(box.x + box.w / 2).toBeCloseTo(86 + 907 / 2, 0);
    expect(box.h).toBeLessThanOrEqual(621 * 0.92 + 1);
  });
  it("checks safe margins and maps normalized zones to integer pixels", () => {
    expect(judgeLayout([{ x: 10, y: 10, w: 100, h: 50 }], { w: 1080, h: 1350 }, 0.05)).toEqual({
      ok: false,
      reason: "zone_overflow",
    });
    expect(zoneToPixels({ x: 0.08, y: 0.1, w: 0.84, h: 0.16 }, { w: 1080, h: 1350 })).toEqual({
      x: 86,
      y: 135,
      w: 907,
      h: 216,
    });
  });
});
