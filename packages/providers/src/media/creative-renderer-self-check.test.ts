import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  renderCreativeRendererSelfCheck,
  verifyCreativeRendererOutput,
} from "./creative-renderer-self-check.js";

describe("creative renderer startup self-check", () => {
  it("renders a feed-sized hero slide with visible content", async () => {
    const bytes = await renderCreativeRendererSelfCheck();
    await expect(verifyCreativeRendererOutput(bytes)).resolves.toBe(true);
  });
  it("rejects a blank canvas and non-image bytes", async () => {
    const blank = new Uint8Array(
      await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#ffffff" } })
        .png()
        .toBuffer(),
    );
    await expect(verifyCreativeRendererOutput(blank)).resolves.toBe(false);
    await expect(verifyCreativeRendererOutput(new Uint8Array([1, 2, 3]))).resolves.toBe(false);
  });
});
