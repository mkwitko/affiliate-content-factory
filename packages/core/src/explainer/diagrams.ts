import {
  type CanvasGeometry,
  PORTRAIT_GEOMETRY,
  SAFE_BOX,
  escapeXml,
  fitFontSize,
  n,
} from "./layout.js";
import { clamp, outBack, outCubic } from "./motion/easing.js";
import { type PropId, renderProp } from "./props.js";

/**
 * Visual explainers that carry the mechanism: flows, comparisons, counters, timelines,
 * before/after and percentages. Every number shown must point at a script claim (claimRef),
 * which scene validation enforces, so a diagram cannot display an unsourced figure.
 */
export type Diagram =
  | Readonly<{
      kind: "flow";
      nodes: readonly Readonly<{ id: string; label: string; icon?: PropId | undefined }>[];
      edges: readonly Readonly<{ from: string; to: string; label?: string | undefined }>[];
    }>
  | Readonly<{
      kind: "bar_compare";
      items: readonly Readonly<{ label: string; value: number; unit?: string | undefined }>[];
      claimRef?: number | undefined;
    }>
  | Readonly<{
      kind: "counter";
      from: number;
      to: number;
      unit?: string | undefined;
      claimRef?: number | undefined;
    }>
  | Readonly<{ kind: "timeline"; points: readonly Readonly<{ label: string; at: string }>[] }>
  | Readonly<{ kind: "before_after"; before: string; after: string }>
  | Readonly<{ kind: "percent"; value: number; label: string; claimRef?: number | undefined }>;
export type DiagramPalette = Readonly<{
  line: string;
  accent: string;
  muted: string;
  text: string;
}>;

/** Above the character band and inside SAFE_BOX. */
export const DIAGRAM_AREA = Object.freeze({
  x: SAFE_BOX.left,
  y: 330,
  width: SAFE_BOX.right - SAFE_BOX.left,
  height: 600,
});
const LEFT = DIAGRAM_AREA.x;
const RIGHT = DIAGRAM_AREA.x + DIAGRAM_AREA.width;
const CENTER_X = LEFT + DIAGRAM_AREA.width / 2;
const TOP = DIAGRAM_AREA.y;

const BOTTOM = DIAGRAM_AREA.y + DIAGRAM_AREA.height;
const FONT = `font-family="Inter, sans-serif"`;

const formatNumber = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

const text = (
  x: number,
  y: number,
  content: string,
  size: number,
  fill: string,
  weight = 700,
): string =>
  `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" ${FONT} font-weight="${weight}" font-size="${n(size)}" fill="${fill}">${escapeXml(content)}</text>`;

/** Greedy word wrap; long single words stay on their own line. */
const wrap = (content: string, maxChars: number): string[] =>
  content
    .trim()
    .split(/\s+/)
    .reduce<string[]>((lines, word) => {
      const last = lines.at(-1);
      if (last !== undefined && `${last} ${word}`.length <= maxChars)
        lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
      return lines;
    }, []);

const lines = (
  x: number,
  y: number,
  content: string,
  maxChars: number,
  size: number,
  fill: string,
): string =>
  wrap(content, maxChars)
    .map((line, index, all) =>
      text(x, y + (index - (all.length - 1) / 2) * size * 1.15, line, size, fill),
    )
    .join("");

/**
 * Build-up for motion frames: k = 1 returns the element untouched (the still), k <= 0 hides it,
 * in between it pops in around (cx, cy).
 */
const reveal = (k: number, cx: number, cy: number, body: string): string => {
  if (k >= 1) return body;
  if (k <= 0) return "";
  const scale = Math.max(0.01, outBack(k));
  return `<g opacity="${n(clamp(k * 3))}" transform="translate(${n(cx)},${n(cy)}) scale(${Math.round(scale * 1000) / 1000}) translate(${n(-cx)},${n(-cy)})">${body}</g>`;
};
/** Local progress of item i of count within an overall progress. */
const stepOf = (progress: number, index: number, count: number) => clamp(progress * count - index);

const arrowMarker = (color: string) =>
  `<defs><marker id="arrow" markerWidth="26" markerHeight="26" refX="22" refY="13" orient="auto" markerUnits="userSpaceOnUse"><path d="M0 0 L26 13 L0 26 z" fill="${color}"/></marker></defs>`;

/** Top-to-bottom flow: a 9:16 frame has more height than width for readable node labels. */
const flow = (
  diagram: Extract<Diagram, { kind: "flow" }>,
  p: DiagramPalette,
  progress: number,
): string => {
  const count = diagram.nodes.length;
  const gap = count >= 5 ? 36 : 56;
  const boxH = Math.min(110, (DIAGRAM_AREA.height - gap * (count - 1)) / count);
  const boxW = 380;
  const boxX = CENTER_X - boxW / 2;
  const start = TOP + (DIAGRAM_AREA.height - (boxH * count + gap * (count - 1))) / 2;
  const yOf = new Map(diagram.nodes.map((node, index) => [node.id, start + index * (boxH + gap)]));
  const nodes = diagram.nodes
    .map((node, index) => {
      const y = start + index * (boxH + gap);
      const size = fitFontSize(node.label, Math.min(44, boxH * 0.42), boxW - 40);
      const icon = node.icon
        ? renderProp({
            type: node.icon,
            x: boxX - 70,
            y: y + boxH / 2,
            scale: Math.min(0.55, boxH / 220),
            palette: { line: p.line, accent: p.accent },
          })
        : "";
      return reveal(
        stepOf(progress, index, count),
        CENTER_X,
        y + boxH / 2,
        `${icon}<rect x="${n(boxX)}" y="${n(y)}" width="${boxW}" height="${n(boxH)}" rx="20" fill="#ffffff" stroke="${p.line}" stroke-width="8"/>${text(CENTER_X, y + boxH / 2 + size * 0.36, node.label, size, p.text)}`,
      );
    })
    .join("");
  const edges = diagram.edges
    .map((edge) => {
      const from = yOf.get(edge.from);
      const to = yOf.get(edge.to);
      if (from === undefined || to === undefined) return "";
      const down = to > from;
      const adjacent = Math.abs(to - from) <= boxH + gap + 1;
      const y1 = down ? from + boxH : from;
      const y2 = down ? to - 4 : to + boxH + 4;
      const path = adjacent
        ? `M${n(CENTER_X)} ${n(y1)} L${n(CENTER_X)} ${n(y2)}`
        : `M${n(boxX + boxW)} ${n(from + boxH / 2)} Q${n(RIGHT)} ${n((from + to + boxH) / 2)} ${n(boxX + boxW + 4)} ${n(to + boxH / 2)}`;
      const label = edge.label
        ? `<text x="${n(CENTER_X + 24)}" y="${n((y1 + y2) / 2 + 12)}" ${FONT} font-weight="700" font-size="34" fill="${p.accent}">${escapeXml(edge.label)}</text>`
        : "";
      const target = diagram.nodes.findIndex((node) => node.id === edge.to);
      const k = stepOf(progress, target, count);
      const body = `<path d="${path}" fill="none" stroke="${p.line}" stroke-width="8" marker-end="url(#arrow)"/>${label}`;
      return k >= 1 ? body : k <= 0 ? "" : `<g opacity="${n(k)}">${body}</g>`;
    })
    .join("");
  return `${arrowMarker(p.line)}${edges}${nodes}`;
};

const bars = (
  diagram: Extract<Diagram, { kind: "bar_compare" }>,
  p: DiagramPalette,
  progress: number,
): string => {
  const max = Math.max(1, ...diagram.items.map((item) => item.value));
  const baseY = BOTTOM - 60;
  const maxH = 420;
  const barW = 120;
  const gap = (DIAGRAM_AREA.width - barW * diagram.items.length) / (diagram.items.length + 1);
  return (
    diagram.items
      .map((item, index) => {
        const x = LEFT + gap + index * (barW + gap);
        const k = stepOf(progress, index, diagram.items.length);
        if (k <= 0) return "";
        const grown = k >= 1 ? 1 : outCubic(k);
        const height = (item.value / max) * maxH * grown;
        const fill = index === diagram.items.length - 1 ? p.accent : p.muted;
        return `<rect data-bar="${index}" x="${n(x)}" y="${n(baseY - height)}" width="${barW}" height="${n(height)}" rx="10" fill="${fill}" stroke="${p.line}" stroke-width="6"/>${text(x + barW / 2, baseY - height - 18, `${formatNumber(k >= 1 ? item.value : item.value * grown)}${item.unit ?? ""}`, 38, p.text, 800)}${text(x + barW / 2, baseY + 48, item.label, fitFontSize(item.label, 40, barW + gap), p.text)}`;
      })
      .join("") +
    `<line x1="${LEFT}" y1="${baseY}" x2="${RIGHT}" y2="${baseY}" stroke="${p.line}" stroke-width="6"/>`
  );
};

const counterLabel = (diagram: Extract<Diagram, { kind: "counter" }>, value = diagram.to): string =>
  `${formatNumber(value)}${diagram.unit ? ` ${diagram.unit}` : ""}`;
const counter = (
  diagram: Extract<Diagram, { kind: "counter" }>,
  p: DiagramPalette,
  progress: number,
): string =>
  text(
    CENTER_X,
    660,
    counterLabel(
      diagram,
      progress >= 1
        ? diagram.to
        : Math.round(diagram.from + (diagram.to - diagram.from) * progress),
    ),
    // Sized for the final value so the number does not change size while counting.
    fitFontSize(counterLabel(diagram), 140, DIAGRAM_AREA.width),
    p.accent,
    800,
  ) +
  text(
    CENTER_X,
    770,
    `${formatNumber(diagram.from)} → ${formatNumber(diagram.to)}`,
    40,
    p.text,
    600,
  );

const timeline = (
  diagram: Extract<Diagram, { kind: "timeline" }>,
  p: DiagramPalette,
  progress: number,
): string => {
  const y = 630;
  const inset = 60;
  const span = DIAGRAM_AREA.width - inset * 2;
  const step = diagram.points.length > 1 ? span / (diagram.points.length - 1) : 0;
  // Width each point's text may use without touching its neighbours.
  const slot = diagram.points.length > 1 ? step : span;
  return (
    `<line x1="${LEFT + inset}" y1="${y}" x2="${progress >= 1 ? RIGHT - inset : n(LEFT + inset + span * clamp(progress))}" y2="${y}" stroke="${p.line}" stroke-width="8"/>` +
    diagram.points
      .map((point, index) => {
        const x = LEFT + inset + index * step;
        return reveal(
          stepOf(progress, index, diagram.points.length),
          x,
          y,
          `<circle cx="${n(x)}" cy="${y}" r="18" fill="${index === diagram.points.length - 1 ? p.accent : "#ffffff"}" stroke="${p.line}" stroke-width="6"/>${text(x, y - 50, point.at, fitFontSize(point.at, 34, slot), p.text, 800)}${lines(x, y + 80, point.label, 10, fitFontSize("x".repeat(10), 34, slot), p.text)}`,
        );
      })
      .join("")
  );
};

const beforeAfter = (
  diagram: Extract<Diagram, { kind: "before_after" }>,
  p: DiagramPalette,
  progress: number,
): string => {
  const cardW = 300;
  const cardY = 440;
  const cardH = 380;
  const card = (x: number, content: string, highlight: boolean) =>
    `<rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="24" fill="${highlight ? p.accent : "#ffffff"}" fill-opacity="${highlight ? 0.2 : 1}" stroke="${p.line}" stroke-width="8"/>${lines(x + cardW / 2, cardY + cardH / 2 + 14, content, 11, 40, p.text)}`;
  const midY = cardY + cardH / 2;
  const first = stepOf(progress, 0, 2);
  const second = stepOf(progress, 1, 2);
  return `${arrowMarker(p.line)}${reveal(first, LEFT + cardW / 2, midY, card(LEFT, diagram.before, false))}${reveal(second, RIGHT - cardW / 2, midY, card(RIGHT - cardW, diagram.after, true))}${second > 0 ? `<path d="M${LEFT + cardW + 20} ${midY} L${RIGHT - cardW - 20} ${midY}" stroke="${p.line}" stroke-width="10" marker-end="url(#arrow)"/>` : ""}`;
};

const percent = (
  diagram: Extract<Diagram, { kind: "percent" }>,
  p: DiagramPalette,
  progress: number,
): string => {
  const r = 180;
  const cy = 590;
  const circumference = 2 * Math.PI * r;
  const shown = progress >= 1 ? diagram.value : Math.round(diagram.value * progress);
  const filled = (Math.max(0, Math.min(100, shown)) / 100) * circumference;
  return (
    `<circle cx="${n(CENTER_X)}" cy="${cy}" r="${r}" fill="none" stroke="${p.muted}" stroke-width="44"/>` +
    `<circle cx="${n(CENTER_X)}" cy="${cy}" r="${r}" fill="none" stroke="${p.accent}" stroke-width="44" stroke-linecap="round" stroke-dasharray="${n(filled)} ${n(circumference)}" transform="rotate(-90 ${n(CENTER_X)} ${cy})"/>` +
    text(CENTER_X, cy + 38, `${formatNumber(shown)}%`, 110, p.text, 800) +
    lines(CENTER_X, cy + r + 90, diagram.label, 22, 40, p.text)
  );
};

/** Build steps a motion frame reveals one by one (each gets a tick sound). */
export const diagramSteps = (diagram: Diagram): number =>
  diagram.kind === "flow"
    ? diagram.nodes.length
    : diagram.kind === "bar_compare"
      ? diagram.items.length
      : diagram.kind === "timeline"
        ? diagram.points.length
        : diagram.kind === "before_after"
          ? 2
          : 1;

/**
 * progress < 1 draws the diagram part-way built (motion frames); the default is the still.
 * Diagrams are laid out in the 750x600 portrait area; landscape moves and scales that whole
 * area onto its own diagram rect, so every kind keeps its proportions.
 */
export const renderDiagram = (
  diagram: Diagram,
  palette: DiagramPalette,
  progress = 1,
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): string => {
  const body =
    diagram.kind === "flow"
      ? flow(diagram, palette, progress)
      : diagram.kind === "bar_compare"
        ? bars(diagram, palette, progress)
        : diagram.kind === "counter"
          ? counter(diagram, palette, progress)
          : diagram.kind === "timeline"
            ? timeline(diagram, palette, progress)
            : diagram.kind === "before_after"
              ? beforeAfter(diagram, palette, progress)
              : percent(diagram, palette, progress);
  if (geometry.canvas === "portrait") return `<g data-diagram="${diagram.kind}">${body}</g>`;
  const { diagramRect: rect, diagramScale: scale } = geometry;
  return `<g data-diagram="${diagram.kind}" transform="translate(${rect.x},${rect.y}) scale(${scale}) translate(${-DIAGRAM_AREA.x},${-DIAGRAM_AREA.y})">${body}</g>`;
};

/** One entry per numeric figure the diagram shows; undefined means no claim backs it. */
export const diagramNumericRefs = (diagram: Diagram): readonly (number | undefined)[] =>
  diagram.kind === "bar_compare" || diagram.kind === "counter" || diagram.kind === "percent"
    ? [diagram.claimRef]
    : [];
