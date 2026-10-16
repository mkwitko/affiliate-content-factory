import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fitImage, reencodeImage } from "./fit-image.js";

const photo = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#ff0000" } })
      .png()
      .toBuffer(),
  );

describe("fitImage", () => {
  it("reports the real dimensions instead of trusting the caller", async () => {
    await expect(fitImage(await photo(500, 400))).resolves.toMatchObject({
      mimeType: "image/png",
      width: 500,
      height: 400,
    });
  });

  it("letterboxes the photo onto the exact channel canvas", async () => {
    const fitted = await fitImage(await photo(500, 400), { width: 1080, height: 1350 });
    const metadata = await sharp(fitted.bytes).metadata();
    expect(fitted).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1350 });
    expect([metadata.format, metadata.width, metadata.height]).toEqual(["jpeg", 1080, 1350]);
  });

  it("rejects bytes that are not an image", async () => {
    await expect(fitImage(new TextEncoder().encode("not an image"))).rejects.toThrow();
  });
});

describe("reencodeImage", () => {
  it("keeps the pixels and drops bytes appended after the image", async () => {
    const png = await photo(600, 520);
    const polyglot = new Uint8Array([...png, ...new TextEncoder().encode("<script>")]);
    const clean = await reencodeImage(polyglot);
    expect(clean).toMatchObject({ mimeType: "image/png", width: 600, height: 520 });
    expect(Buffer.from(clean.bytes).includes("<script>")).toBe(false);
  });

  it("refuses truncated files and pixel bombs", async () => {
    const png = await photo(600, 520);
    await expect(reencodeImage(png.slice(0, png.length / 2))).rejects.toThrow();
    await expect(reencodeImage(png, 1000)).rejects.toThrow();
  });
});
