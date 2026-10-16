import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  gradePlateImage,
  rasterizeFrame,
  STYLE_THUMB_SIZE,
  thumbnailFrame,
  tileSheet,
} from "./style-frame-images.js";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#F6F1E7"/><circle cx="540" cy="900" r="200" fill="#FF5A36"/></svg>`;

describe("style-frame images", () => {
  it("rasterises a full frame, thumbnails it to 160x284 and tiles labelled sheets", async () => {
    const png = await rasterizeFrame(svg);
    expect(await sharp(Buffer.from(png)).metadata()).toMatchObject({ width: 1080, height: 1920 });
    const thumb = await thumbnailFrame(png);
    expect(await sharp(Buffer.from(thumb)).metadata()).toMatchObject(STYLE_THUMB_SIZE);
    const sheet = await tileSheet(
      [
        { label: "A", png: thumb },
        { label: "B", png: thumb },
        { label: "", png: thumb },
      ],
      STYLE_THUMB_SIZE,
    );
    expect(await sharp(Buffer.from(sheet)).metadata()).toMatchObject({
      width: 160 * 3 + 8 * 2,
      height: 284,
    });
  });

  it("grades a plate darker for night and keeps its size", async () => {
    const plate = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#c0a070" },
    })
      .jpeg()
      .toBuffer();
    const night = await gradePlateImage(new Uint8Array(plate), {
      brightness: 0.45,
      saturation: 0.7,
      tint: "#3b4a7a",
    });
    const before = await sharp(plate).stats();
    const after = await sharp(Buffer.from(night)).stats();
    expect(await sharp(Buffer.from(night)).metadata()).toMatchObject({ width: 64, height: 64 });
    expect(after.channels[0]?.mean ?? 0).toBeLessThan(before.channels[0]?.mean ?? 0);
  });
});
