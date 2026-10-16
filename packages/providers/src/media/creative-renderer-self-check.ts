import sharp from "sharp";
import { DEFAULT_BRAND_KIT } from "@money-maker/core/brand/brand-kit";
import { templateFor } from "@money-maker/core/creatives/templates";
import { createSharpCreativeRenderer } from "./sharp-creative-renderer.js";

const SELF_CHECK_TEMPLATE = templateFor("hero", "feed");

export const renderCreativeRendererSelfCheck = async (): Promise<Uint8Array> => {
  const product = new Uint8Array(
    await sharp({ create: { width: 10, height: 10, channels: 4, background: "#333333" } })
      .png()
      .toBuffer(),
  );
  const output = await createSharpCreativeRenderer().render({
    canvas: "feed",
    template: SELF_CHECK_TEMPLATE,
    spec: { index: 1, total: 1, template: "hero", headline: "Renderer ready", claims: [] },
    brand: DEFAULT_BRAND_KIT,
    product: { png: product, mode: "cutout" },
    background: { procedural: true },
  });
  return output.bytes;
};

/**
 * True when the self-check output is a JPEG or PNG of the feed canvas size with visible content.
 * Byte-exact hashes differ across libvips and fontconfig builds, so the check is structural.
 */
export const verifyCreativeRendererOutput = async (bytes: Uint8Array): Promise<boolean> => {
  try {
    const image = sharp(bytes);
    const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
    const sized =
      (metadata.format === "jpeg" || metadata.format === "png") &&
      metadata.width === SELF_CHECK_TEMPLATE.canvas.w &&
      metadata.height === SELF_CHECK_TEMPLATE.canvas.h;
    const hasContent = stats.channels.some((channel) => channel.stdev > 1);
    return sized && hasContent;
  } catch {
    return false;
  }
};
