import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { proceduralScene } from "./procedural-scene.js";

describe("proceduralScene", () => {
  it("renders the requested PNG dimensions with a central radial light", async () => {
    const bytes = await proceduralScene({
      width: 64,
      height: 64,
      palette: { primary: "#0B1F3A", accent: "#22D3EE", surface: "#F5F7FA", text: "#FFFFFF" },
    });
    const image = sharp(bytes);
    expect(await image.metadata()).toMatchObject({ format: "png", width: 64, height: 64 });
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const value = (x: number, y: number) => data[(y * info.width + x) * info.channels] ?? 0;
    expect(value(0, 0)).toBeLessThan(value(32, 32));
  });
});
