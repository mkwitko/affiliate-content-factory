import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { createSharpStoryImageComposer } from "./sharp-story-image-composer.js";

const slide = async (width: number, height: number) => ({
  bytes: new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 10 } } })
      .jpeg()
      .toBuffer(),
  ),
  mimeType: "image/jpeg",
  width,
  height,
});

describe("createSharpStoryImageComposer", () => {
  it("composites a 4:5 carousel slide onto a 1080x1920 Stories frame", async () => {
    const output = await createSharpStoryImageComposer().compose(await slide(1080, 1350));
    expect(output).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1920 });
    const stored = await sharp(output.bytes).metadata();
    expect([stored.width, stored.height]).toEqual([1080, 1920]);
  });

  it("fills the frame directly when the slide is already Stories-shaped", async () => {
    const output = await createSharpStoryImageComposer().compose(await slide(1080, 1920));
    expect(output).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1920 });
  });
});
