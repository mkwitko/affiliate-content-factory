import type {
  CreativeRenderer,
  PixelBox,
  RenderSlideInput,
} from "@money-maker/core/creatives/creative-renderer";
import {
  fitHeadline,
  judgeLayout,
  placeProduct,
  wrapText,
  zoneToPixels,
} from "@money-maker/core/creatives/layout";
import { validateSlideSpec } from "@money-maker/core/creatives/slide-spec";
import { CANVASES } from "@money-maker/core/creatives/templates";
import sharp, { type OverlayOptions, type Sharp } from "sharp";
import { configureBundledFonts } from "./fonts.js";
import { inSceneOverlay } from "./in-scene-overlay.js";
import { proceduralScene } from "./procedural-scene.js";
import { inkBoxes } from "./text-ink.js";

/** sharp letterboxes `fit: "contain"` in opaque black unless told otherwise. */
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 } as const;

const escapeXml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char,
  );
const svgBuffer = (width: number, height: number, content: string): Buffer =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>`,
  );
const lineText = (
  lines: readonly string[],
  box: PixelBox,
  size: number,
  color: string,
  weight: number,
  align: "left" | "center" | "right",
  family = "Inter",
): string => {
  const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
  const x = align === "center" ? box.x + box.w / 2 : align === "right" ? box.x + box.w : box.x;
  const totalHeight = lines.length * size * 1.08;
  const startY = box.y + Math.max(size, (box.h - totalHeight) / 2 + size);
  return `<text x="${x}" y="${startY}" text-anchor="${anchor}" fill="${color}" font-family="${family}" font-size="${size}" font-weight="${weight}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : size * 1.08}">${escapeXml(line)}</tspan>`).join("")}</text>`;
};

const backgroundScrim = (input: RenderSlideInput, width: number, height: number): string => {
  const color = input.brand.palette.primary;
  const top = input.template.scrim === "top" || input.template.scrim === "both";
  const bottom = input.template.scrim === "bottom" || input.template.scrim === "both";
  return `<defs><linearGradient id="scrimTop" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${color}" stop-opacity=".75"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient><linearGradient id="scrimBottom" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${color}" stop-opacity="0"/><stop offset="1" stop-color="${color}" stop-opacity=".85"/></linearGradient></defs>${top ? `<rect width="${width}" height="${Math.round(height * 0.3)}" fill="url(#scrimTop)"/>` : ""}${bottom ? `<rect y="${Math.round(height * 0.65)}" width="${width}" height="${Math.round(height * 0.35)}" fill="url(#scrimBottom)"/>` : ""}`;
};

const imageShadow = (input: Uint8Array, box: PixelBox): string => {
  const source = Buffer.from(input).toString("base64");
  return `<defs><filter id="drop" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur in="SourceAlpha" stdDeviation="28"/><feOffset dx="0" dy="18" result="offset"/><feComponentTransfer><feFuncA type="linear" slope=".35"/></feComponentTransfer><feFlood flood-color="#000"/><feComposite in2="offset" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><image href="data:image/png;base64,${source}" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" preserveAspectRatio="none" filter="url(#drop)"/>`;
};

const createTextLayer = (
  input: RenderSlideInput,
  width: number,
  height: number,
  headline: { fontSize: number; lines: readonly string[] },
  bodyDropped: boolean,
  productBox: PixelBox,
): { svg: string; boxes: PixelBox[] } => {
  const boxes: PixelBox[] = [headlineBox(input, width, height), productBox];
  const markBox = zoneToPixels(input.template.markZone, { w: width, h: height });
  const slideBox = zoneToPixels(input.template.slideNumberZone, { w: width, h: height });
  // Template marks intentionally sit inside the top safe area; their presence is checked separately.
  const parts = [
    lineText(
      headline.lines,
      boxes[0]!,
      headline.fontSize,
      input.brand.palette.text,
      input.brand.typography.headingWeight,
      input.template.textAlign,
    ),
  ];
  if (input.brand.brandName.trim() && !input.logo) {
    const mark = [input.brand.brandName, input.brand.nicheLabel].filter(Boolean).join(" · ");
    parts.push(
      lineText(
        [mark],
        markBox,
        Math.max(20, Math.round(markBox.h * 0.48)),
        input.brand.palette.text,
        700,
        "left",
      ),
    );
  }
  parts.push(
    lineText(
      [`${input.spec.index}/${input.spec.total}`],
      slideBox,
      Math.max(16, Math.round(slideBox.h * 0.52)),
      input.brand.palette.text,
      500,
      "right",
    ),
  );
  const bodyZone = input.template.bodyZone
    ? zoneToPixels(input.template.bodyZone, { w: width, h: height })
    : undefined;
  if (input.spec.body && bodyZone && !bodyDropped) {
    const fontSize = Math.max(20, Math.round(width * 0.026));
    const lines = wrapText(
      input.spec.body,
      Math.max(1, Math.floor(bodyZone.w / (fontSize * 0.52))),
    );
    if (lines.length * fontSize * 1.2 <= bodyZone.h) {
      boxes.push(bodyZone);
      parts.push(
        lineText(
          lines,
          bodyZone,
          fontSize,
          input.brand.palette.text,
          input.brand.typography.bodyWeight,
          input.template.textAlign,
        ),
      );
    }
  }
  const badgeZone = input.template.badgeZone
    ? zoneToPixels(input.template.badgeZone, { w: width, h: height })
    : undefined;
  if (input.spec.badge && badgeZone) {
    boxes.push(badgeZone);
    const radius = Math.round(badgeZone.h / 2);
    parts.push(
      `<rect x="${badgeZone.x}" y="${badgeZone.y}" width="${badgeZone.w}" height="${badgeZone.h}" rx="${radius}" fill="${input.brand.palette.accent}"/>`,
    );
    parts.push(
      lineText(
        [input.spec.badge],
        { ...badgeZone, y: badgeZone.y + 2 },
        Math.max(18, Math.round(badgeZone.h * 0.52)),
        input.brand.palette.primary,
        700,
        "center",
      ),
    );
  }
  if (input.spec.disclosure) {
    const disclosureBox = {
      x: Math.round(width * 0.06),
      y: Math.round(height * 0.9),
      w: Math.round(width * 0.88),
      h: Math.round(height * 0.035),
    };
    boxes.push(disclosureBox);
    parts.push(
      lineText(
        [input.spec.disclosure],
        disclosureBox,
        Math.max(12, Math.round(height * 0.012)),
        input.brand.palette.muted ?? input.brand.palette.text,
        400,
        "left",
      ),
    );
  }
  return { svg: parts.join(""), boxes };
};

const headlineBox = (input: RenderSlideInput, width: number, height: number): PixelBox =>
  zoneToPixels(input.template.headlineZone, { w: width, h: height });

const storyFrame = async (
  png: Uint8Array,
  cover: Sharp,
  width: number,
  height: number,
): Promise<Buffer> => {
  const front = await sharp(png).resize({ width, kernel: "lanczos3" }).png().toBuffer();
  const frontHeight = (await sharp(front).metadata()).height ?? height;
  // Blurred at an eighth of the size and scaled back: same look as a wide blur, a fraction of
  // the work on 1080x1920.
  const small = await cover
    .resize(Math.round(width / 8), Math.round(height / 8))
    .blur(4)
    .modulate({ brightness: 0.7 })
    .png()
    .toBuffer();
  const back = await sharp(small).resize(width, height).png().toBuffer();
  return sharp(back)
    .composite([{ input: front, top: Math.round((height - frontHeight) / 2), left: 0 }])
    .png()
    .toBuffer();
};

export const createSharpCreativeRenderer = (): CreativeRenderer => ({
  async render(input) {
    configureBundledFonts();
    const canvas = CANVASES[input.canvas];
    const width = canvas.w;
    const height = canvas.h;
    if (input.template.canvas.w !== width || input.template.canvas.h !== height)
      throw new Error("layout_failed:canvas_mismatch");
    const verdict = validateSlideSpec(input.spec);
    if (!verdict.ok) throw new Error(`layout_failed:${verdict.reason}`);
    if ("inScene" in input.product) {
      if (!("png" in input.background))
        throw new Error("layout_failed:in_scene_background_required");
      if (!input.brand.brandName.trim() && !input.logo)
        throw new Error("layout_failed:mark_missing");
      const meta = await sharp(input.background.png).metadata();
      const source = meta.width && meta.height ? { w: meta.width, h: meta.height } : undefined;
      // Native story frame (brief 15): a feed scene on a story keeps its full width, centred on
      // a blurred, darkened copy of itself, instead of losing a third of it to a cover crop.
      const framed =
        input.canvas === "story" &&
        source !== undefined &&
        source.w / source.h > (width / height) * 1.15;
      const cover = sharp(input.background.png).resize(width, height, {
        fit: "cover",
        position: "centre",
        kernel: "lanczos3",
      });
      const scene = framed
        ? await storyFrame(input.background.png, cover, width, height)
        : await cover.png().toBuffer();
      const overlay = await inSceneOverlay(
        input,
        width,
        height,
        input.subjects?.length ? source : undefined,
        framed ? "width" : "cover",
      );
      const overlayPng = await sharp({
        create: { width, height, channels: 4, background: TRANSPARENT },
      })
        .composite(overlay.layers)
        .png()
        .toBuffer();
      const svgLayer = overlay.layers[0]?.input;
      const ink = Buffer.isBuffer(svgLayer)
        ? await inkBoxes(svgLayer.toString("utf8"), { w: width, h: height })
        : {};
      return {
        bytes: new Uint8Array(
          await sharp(scene).composite(overlay.layers).jpeg({ quality: 92 }).toBuffer(),
        ),
        overlay: new Uint8Array(overlayPng),
        mimeType: "image/jpeg",
        width,
        height,
        layout: {
          headlineFontSize: overlay.headlineFontSize,
          bodyDropped: overlay.bodyDropped,
          boxes: overlay.boxes,
          ink,
          ...(overlay.subjectLayout ? { subjectLayout: overlay.subjectLayout } : {}),
        },
      };
    }
    const headlineZone = headlineBox(input, width, height);
    const fitted = fitHeadline(input.spec.headline, headlineZone, input.template.maxHeadlineLines);
    if (!fitted) throw new Error("layout_failed:headline_unfit");
    let bodyDropped = Boolean(
      input.spec.body && fitted.fontSize <= Math.round((headlineZone.w / 0.84) * 0.065),
    );
    if (input.spec.body && input.template.bodyZone) {
      const bodyBox = zoneToPixels(input.template.bodyZone, canvas);
      const bodySize = Math.max(20, Math.round(width * 0.026));
      const bodyLines = wrapText(
        input.spec.body,
        Math.max(1, Math.floor(bodyBox.w / (bodySize * 0.52))),
      );
      if (bodyLines.length * bodySize * 1.2 > bodyBox.h) bodyDropped = true;
    }

    const backgroundBytes =
      "png" in input.background
        ? input.background.png
        : await proceduralScene({ width, height, palette: input.brand.palette });
    const background = await sharp(backgroundBytes)
      .resize(width, height, { fit: "cover", position: "centre", kernel: "lanczos3" })
      .png()
      .toBuffer();
    const layers: OverlayOptions[] = [
      { input: svgBuffer(width, height, backgroundScrim(input, width, height)) },
    ];
    const productZone = zoneToPixels(input.template.productZone, canvas);
    let actualProductBox: PixelBox = productZone;
    let productBytes: Buffer | undefined;
    if (!("inScene" in input.product)) {
      const { product } = input;
      const productMetadata = await sharp(product.png).metadata();
      if (!productMetadata.width || !productMetadata.height)
        throw new Error("layout_failed:product_dimensions");
      const productBox = placeProduct(
        { w: productMetadata.width, h: productMetadata.height },
        productZone,
        Math.round(input.template.surfaceY * height),
        input.template.productAnchor,
      );
      productBytes =
        product.mode === "cutout"
          ? await sharp(product.png)
              .trim({ threshold: 1 })
              .resize(productBox.w, productBox.h, {
                fit: "contain",
                withoutEnlargement: true,
                background: TRANSPARENT,
              })
              .png()
              .toBuffer()
          : await sharp(product.png)
              .resize(Math.round(productBox.w * 0.88), Math.round(productBox.h * 0.88), {
                fit: "contain",
                withoutEnlargement: true,
                background: TRANSPARENT,
              })
              .png()
              .toBuffer();
      const contact = svgBuffer(
        width,
        height,
        `<defs><filter id="blur"><feGaussianBlur stdDeviation="18"/></filter></defs><ellipse cx="${productBox.x + productBox.w / 2}" cy="${Math.min(height - 1, productBox.y + productBox.h)}" rx="${productBox.w * 0.38}" ry="${Math.max(8, productBox.w * 0.04)}" fill="#000" opacity=".38" filter="url(#blur)"/>`,
      );
      layers.push({ input: contact });
      actualProductBox = productBox;
      if (product.mode === "framed") {
        const card = {
          ...productBox,
          x: productBox.x + Math.round(productBox.w * 0.06),
          y: productBox.y + Math.round(productBox.h * 0.04),
          w: Math.round(productBox.w * 0.88),
          h: Math.round(productBox.h * 0.88),
        };
        layers.push({
          input: svgBuffer(
            width,
            height,
            `<rect x="${productBox.x}" y="${productBox.y}" width="${productBox.w}" height="${productBox.h}" rx="32" fill="#fff"/>`,
          ),
        });
        actualProductBox = card;
      }
      layers.push({ input: svgBuffer(width, height, imageShadow(productBytes, actualProductBox)) });
      layers.push({
        input: Buffer.from(productBytes),
        left: actualProductBox.x,
        top: actualProductBox.y,
      });
    }
    if (input.logo) {
      const mark = zoneToPixels(input.template.markZone, canvas);
      layers.push({
        input: await sharp(input.logo.png)
          .resize(mark.w, mark.h, { fit: "contain" })
          .png()
          .toBuffer(),
        left: mark.x,
        top: mark.y,
      });
    }
    const text = createTextLayer(input, width, height, fitted, bodyDropped, actualProductBox);
    if (!input.brand.brandName.trim() && !input.logo) throw new Error("layout_failed:mark_missing");
    const layout = judgeLayout(text.boxes, canvas, input.brand.mark.safeMargin);
    if (!layout.ok) throw new Error(`layout_failed:${layout.reason}`);
    layers.push({ input: svgBuffer(width, height, text.svg) });
    const bytes = await sharp(background).composite(layers).jpeg({ quality: 92 }).toBuffer();
    const layer = productBytes ? await sharp(productBytes).metadata() : undefined;
    return {
      bytes: new Uint8Array(bytes),
      mimeType: "image/jpeg",
      width,
      height,
      layout: { headlineFontSize: fitted.fontSize, bodyDropped },
      ...(productBytes && layer
        ? {
            product: {
              layer: new Uint8Array(productBytes),
              region: {
                x: actualProductBox.x,
                y: actualProductBox.y,
                w: layer.width ?? actualProductBox.w,
                h: layer.height ?? actualProductBox.h,
              },
            },
          }
        : {}),
    };
  },
});
