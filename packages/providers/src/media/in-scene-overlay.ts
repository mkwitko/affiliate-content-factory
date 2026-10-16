import { type BrandTokens, brandTokens } from "@money-maker/core/brand/brand-kit";
import type { CreativeBoxKey } from "@money-maker/core/creatives/creative-document";
import type { PixelBox, RenderSlideInput } from "@money-maker/core/creatives/creative-renderer";
import { wrapText } from "@money-maker/core/creatives/layout";
import {
  contrastRatio,
  PLATFORM_PRESETS,
  pillLabelColour,
  presetForCanvas,
  showCounter,
  uiFreeRows,
} from "@money-maker/core/creatives/platform-presets";
import { priceBadgeText } from "@money-maker/core/creatives/price-display";
import {
  chooseSubjectLayout,
  type MeasuredBlock,
  type SubjectLayout,
  subjectsOnCanvas,
} from "@money-maker/core/creatives/subject-layout";
import { emphasisFor, IN_SCENE_EMPHASIS } from "@money-maker/core/creatives/templates";
import sharp, { type OverlayOptions } from "sharp";

/** Average Inter advance per em for bold / medium weights; deliberately conservative. */
const BOLD = 0.6;
const MEDIUM = 0.58;
const FONT = "Inter";

const esc = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const est = (text: string, size: number, factor = BOLD): number => text.length * size * factor;

type Pill = { svg: string; h: number; w: number };
const pill = (x: number, y: number, w: number, h: number, fill: string, opacity = 1): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}" fill-opacity="${opacity}"/>`;
const txt = (
  x: number,
  y: number,
  size: number,
  fill: string,
  weight: number,
  content: string,
  anchor: "start" | "middle" = "start",
  extra = "",
): string =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${fill}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ${extra}>${esc(content)}</text>`;

/** White text on the disclosure pill unless that misses the minimum contrast; fails closed. */
export const disclosureTextColour = (pillFill: string, minContrast: number): string => {
  for (const colour of ["#ffffff", "#000000"])
    if (contrastRatio(colour, pillFill) >= minContrast) return colour;
  throw new Error("layout_failed:disclosure_contrast");
};

/** "De R$ X por R$ Y" -> strikethrough X (small) + Y (big); anything else is one big label. */
const pricePill = (
  badge: string,
  W: number,
  x: number,
  bottom: number,
  accent: string,
  t: BrandTokens,
  f = 1,
  label = "#fff",
): Pill => {
  const big = Math.round(W * 0.062 * f);
  const small = Math.round(W * 0.03 * f);
  const h = Math.round(big * 1.7);
  const pad = Math.round(h * t.pillPadding);
  const y = bottom - h;
  const base = y + Math.round(h / 2 + big * 0.35);
  const promo = /^De\s+(R\$\s?[\d.,]+)\s+por\s+(R\$\s?[\d.,]+)$/i.exec(badge.trim());
  if (!promo) {
    const w = Math.round(est(badge, big) + pad * 2);
    return {
      w,
      h,
      svg:
        pill(x, y, w, h, accent) +
        txt(x + w / 2, base, big, label, 800, badge, "middle", 'data-box="price"'),
    };
  }
  const old = `De ${promo[1]}`;
  const now = promo[2] ?? "";
  const oldW = est(old, small);
  const gap = Math.round(pad * 0.6);
  const w = Math.round(pad + oldW + gap + est(now, big) + pad);
  const oldX = x + pad;
  const oldY = base - Math.round(big * 0.02);
  const strikeY = oldY - small * 0.32;
  return {
    w,
    h,
    svg:
      pill(x, y, w, h, accent) +
      txt(oldX, oldY, small, label, 700, old, "start", 'fill-opacity=".9" data-box="price"') +
      `<line x1="${oldX}" y1="${strikeY}" x2="${oldX + oldW * 0.92}" y2="${strikeY}" stroke="${label}" stroke-width="${Math.max(3, small * 0.12)}" stroke-opacity=".95"/>` +
      txt(oldX + oldW + gap, base, big, label, 800, now, "start", 'data-box="price"'),
  };
};

const fitHeadline = (
  headline: string,
  width: number,
  t: BrandTokens,
  scale: number,
): { size: number; dark: readonly string[]; accent: readonly string[] } | null => {
  const [first = "", ...rest] = headline.split("\n");
  const second = rest.join(" ").trim();
  for (let step = 0; step < 5; step++) {
    const size = Math.round(
      (t.headlineMaxPx - ((t.headlineMaxPx - t.headlineMinPx) * step) / 4) * scale,
    );
    // Same advance as `est`: 0.5 em let heavy headlines run off the canvas (porta-tempero
    // cover 2026-10-09, "comprar e" cut at the right edge).
    const maxChars = Math.max(1, Math.floor(width / (size * BOLD)));
    const dark = wrapText(first, maxChars);
    const accent = second ? wrapText(second, maxChars) : [];
    if (dark.length + accent.length <= 3 && [...dark, ...accent].every((l) => l.length <= maxChars))
      return { size, dark, accent };
  }
  return null;
};

type Boxes = Partial<Record<CreativeBoxKey, PixelBox>>;

/**
 * Everything drawn over a full generated scene: logo badge, counter, two-tone headline, price,
 * body card, tags. With `input.subjects` (and the scene's pixel `source` size) the two stacks
 * are placed by `chooseSubjectLayout` so text stays off faces, heads and the product; without
 * them the default layout is drawn unchanged.
 */
export const inSceneOverlay = async (
  input: RenderSlideInput,
  W: number,
  H: number,
  source?: Readonly<{ w: number; h: number }>,
  fit: "cover" | "width" = "cover",
): Promise<{
  layers: OverlayOptions[];
  bodyDropped: boolean;
  headlineFontSize: number;
  boxes: Boxes;
  subjectLayout?: SubjectLayout;
}> => {
  const { accent } = input.brand.palette;
  const dark = input.brand.palette.dark ?? input.brand.palette.primary;
  const light = input.brand.palette.light ?? input.brand.palette.surface;
  const pillLabel = pillLabelColour(accent, dark);
  const t = brandTokens(input.brand);
  const em = IN_SCENE_EMPHASIS[emphasisFor(input.spec.template)];
  const scale = W / 1080;
  const story = input.canvas === "story";
  const preset = input.preset ? PLATFORM_PRESETS[input.preset] : presetForCanvas(input.canvas);
  const free = uiFreeRows(preset, H);
  const m = Math.round(W * 0.06);
  const maxW = W - 2 * m;
  const parts: string[] = [
    `<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur in="SourceAlpha" stdDeviation="${Math.round(W * 0.006)}"/><feOffset dy="${Math.round(W * 0.004)}" result="b"/><feComponentTransfer><feFuncA type="linear" slope="${t.shadowOpacity}"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`,
  ];
  const layers: OverlayOptions[] = [];
  const d = Math.round(W * 0.13);
  const top = Math.max(Math.round(story ? H * 0.065 : m), free.top);
  const gap = Math.round(W * 0.022);
  const bottomAnchor = Math.min(H - Math.round(story ? H * 0.06 : m * 0.8), free.bottom);

  // Top stack at (x, y): logo badge, then the two-tone headline with a white halo (or on a
  // solid white card when no placement keeps it off the subjects).
  const drawTop = (x: number, y: number, width: number, f: number, card: boolean) => {
    const out: string[] = [];
    const boxes: Boxes = {};
    if (input.logo) {
      out.push(
        `<circle cx="${x + d / 2}" cy="${y + d / 2}" r="${d / 2 - 2}" fill="#fff" stroke="${accent}" stroke-width="4" filter="url(#sh)"/>`,
      );
      boxes.logo = { x, y, w: d, h: d };
    } else {
      const label = input.brand.brandName;
      const size = Math.round(d * 0.3);
      const w = Math.round(est(label, size) + size);
      out.push(
        pill(x, y + d / 4, w, d / 2, "#fff", 0.92),
        txt(x + w / 2, y + d / 2 + size * 0.35, size, dark, 800, label, "middle"),
      );
      boxes.logo = { x, y: y + d / 4, w, h: d / 2 };
    }
    const pad = card ? Math.round(W * 0.025) : 0;
    const head = fitHeadline(input.spec.headline, width - 2 * pad, t, scale * f * em.headline);
    if (!head) return null;
    const lineH = Math.round(head.size * 1.1);
    const headTop = y + d + Math.round(H * 0.03);
    const lines = [
      ...head.dark.map((l) => [l, dark] as const),
      ...head.accent.map((l) => [l, accent] as const),
    ];
    const textW = Math.min(
      width - 2 * pad,
      Math.max(...lines.map(([line]) => est(line, head.size))) + head.size * t.haloEm,
    );
    const headH = lines.length * lineH + 2 * pad;
    boxes.headline = { x, y: headTop, w: Math.round(textW + 2 * pad), h: headH };
    if (card)
      out.push(
        `<rect x="${x}" y="${headTop}" width="${boxes.headline.w}" height="${headH}" rx="${Math.round(t.radius * scale)}" fill="#fff" filter="url(#sh)"/>`,
      );
    const halo = `stroke="#fff" stroke-width="${Math.round(head.size * t.haloEm)}" stroke-linejoin="round" paint-order="stroke" filter="url(#sh)"`;
    lines.forEach(([line, color], i) => {
      out.push(
        txt(
          x + pad,
          headTop + pad + head.size + i * lineH,
          head.size,
          color,
          t.weightHeadline,
          line,
          "start",
          `${halo} data-box="headline"`,
        ),
      );
    });
    return {
      out,
      boxes,
      size: head.size,
      bottom: headTop + headH,
      w: Math.max(boxes.logo.w, boxes.headline.w),
    };
  };

  // Bottom stack anchored at `bottomAnchor`, built upwards: disclosure tag, CTA (story), body
  // card, price.
  const drawBottom = (x: number, width: number, f: number) => {
    const out: string[] = [];
    const boxes: Boxes = {};
    let cursor = bottomAnchor;
    if (input.spec.disclosure) {
      const size = Math.round((Math.max(t.disclosurePx, preset.disclosure.minPx) * W) / 1080);
      const h = Math.round(size * 1.9);
      const w = Math.round(est(input.spec.disclosure, size) + size * 1.6);
      const tagFill = disclosureTextColour("#000000", preset.disclosure.minContrast);
      out.push(
        pill(x, cursor - h, w, h, "#000", 0.5),
        txt(
          x + w / 2,
          cursor - h / 2 + size * 0.35,
          size,
          tagFill,
          700,
          input.spec.disclosure,
          "middle",
          'data-box="disclosure"',
        ),
      );
      boxes.disclosure = { x, y: cursor - h, w, h };
      cursor -= h + gap;
    }
    if (input.captionBand) cursor = Math.min(cursor, Math.round(H * input.captionBand.top) - gap);
    if (input.cta) {
      const size = Math.round(W * 0.042 * em.cta);
      const h = Math.round(size * 2);
      const w = Math.round(est(input.cta, size) + size * 2.4);
      out.push(
        pill(x, cursor - h, w, h, accent),
        txt(
          x + w / 2,
          cursor - h / 2 + size * 0.35,
          size,
          pillLabel,
          800,
          input.cta,
          "middle",
          // The drop shadow helps white text only; it muddies a dark label.
          `${pillLabel === "#ffffff" ? 'filter="url(#sh)" ' : ""}data-box="cta"`,
        ),
      );
      boxes.cta = { x, y: cursor - h, w, h };
      cursor -= h + gap;
    }
    let bodyDropped = false;
    if (input.spec.body) {
      const pad = Math.round(W * 0.03);
      const textW = width - 2 * pad;
      let fit: { size: number; lines: readonly string[] } | undefined;
      for (const size of [0, -4, -8].map((n) => (t.bodyPx + n + (story ? 4 : 0)) * f)) {
        const lines = wrapText(input.spec.body, Math.floor(textW / (size * MEDIUM)));
        if (lines.length <= 3) {
          fit = { size, lines };
          break;
        }
      }
      if (fit) {
        const lh = Math.round(fit.size * 1.28);
        const h = fit.lines.length * lh + pad * 1.4;
        const y = cursor - h;
        out.push(
          `<rect x="${x}" y="${y}" width="${width}" height="${h}" rx="${Math.round(t.radius * scale)}" fill="#fff" fill-opacity=".92" filter="url(#sh)"/>`,
        );
        fit.lines.forEach((line, i) => {
          out.push(
            txt(
              x + pad,
              y + pad * 0.7 + fit.size + i * lh,
              fit.size,
              dark,
              t.weightBody,
              line,
              "start",
              'data-box="body"',
            ),
          );
        });
        boxes.body = { x, y, w: width, h };
        cursor = y - gap;
      } else bodyDropped = true;
    }
    const priceText = input.price ? priceBadgeText(input.price) : input.spec.badge;
    if (priceText) {
      const p = pricePill(priceText, W, x, cursor, accent, t, f * em.price, pillLabel);
      out.push(p.svg.replace("<rect", '<rect filter="url(#sh)"'));
      boxes.price = { x, y: cursor - p.h, w: p.w, h: p.h };
      cursor -= p.h;
    }
    const drawn = Object.values(boxes);
    const blockTop = Math.min(bottomAnchor, ...drawn.map((box) => box.y));
    return {
      out,
      boxes,
      bodyDropped,
      cursor,
      blockTop,
      w: Math.max(0, ...drawn.map((box) => box.x + box.w - x)),
    };
  };

  const subjects =
    input.subjects?.length && source
      ? subjectsOnCanvas(input.subjects, source, { w: W, h: H }, fit)
      : [];
  const subjectLayout =
    subjects.length > 0
      ? (chooseSubjectLayout({
          area: { x: m, y: top, w: maxW, h: bottomAnchor - top },
          gap,
          subjects,
          measure: (block, width, f, card): MeasuredBlock | null => {
            if (block === "top") {
              const drawn = drawTop(0, 0, width, f, card);
              return drawn
                ? { w: drawn.w, h: drawn.bottom, items: Object.values(drawn.boxes) }
                : null;
            }
            const drawn = drawBottom(0, width, f);
            return {
              w: drawn.w,
              h: bottomAnchor - drawn.blockTop,
              items: Object.values(drawn.boxes).map((box) => ({
                ...box,
                y: box.y - drawn.blockTop,
              })),
            };
          },
        }) ?? undefined)
      : undefined;

  const topStack = subjectLayout
    ? drawTop(
        subjectLayout.top.box.x,
        subjectLayout.top.box.y,
        subjectLayout.top.width,
        subjectLayout.top.scale,
        subjectLayout.top.card,
      )
    : drawTop(m, top, maxW, 1, false);
  if (!topStack) throw new Error("layout_failed:headline_unfit");
  if (input.logo) {
    const logoBox = topStack.boxes.logo ?? { x: m, y: top };
    const inner = Math.round(d * 0.72);
    layers.push({
      input: await sharp(input.logo.png)
        .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
      left: logoBox.x + Math.round((d - inner) / 2),
      top: logoBox.y + Math.round((d - inner) / 2),
    });
  }
  parts.push(...topStack.out.slice(0, input.logo ? 1 : 2));

  // Counter pill, top-right; never on a single image.
  if (showCounter(preset, input.spec.total)) {
    const cSize = Math.round(W * 0.03);
    const cH = Math.round(cSize * 1.9);
    const cLabel = `${input.spec.index}/${input.spec.total}`;
    const cW = Math.round(est(cLabel, cSize) + cSize * 1.6);
    const cY = top + Math.round((d - cH) / 2);
    parts.push(
      pill(W - m - cW, cY, cW, cH, light, 0.95),
      txt(W - m - cW / 2, cY + cH / 2 + cSize * 0.35, cSize, dark, 700, cLabel, "middle"),
    );
  }
  parts.push(...topStack.out.slice(input.logo ? 1 : 2));

  const bottomStack = subjectLayout
    ? drawBottom(subjectLayout.bottom.box.x, subjectLayout.bottom.width, subjectLayout.bottom.scale)
    : drawBottom(m, maxW, 1);
  parts.push(...bottomStack.out);
  if (!subjectLayout && bottomStack.cursor < topStack.bottom)
    throw new Error("layout_failed:zone_overflow");

  layers.unshift({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("")}</svg>`,
    ),
  });
  return {
    layers,
    bodyDropped: bottomStack.bodyDropped,
    headlineFontSize: topStack.size,
    boxes: { ...topStack.boxes, ...bottomStack.boxes },
    ...(subjectLayout ? { subjectLayout } : {}),
  };
};
