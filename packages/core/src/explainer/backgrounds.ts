import { type CanvasGeometry, PORTRAIT_GEOMETRY } from "./layout.js";

/**
 * Flat, low-contrast settings. Shapes stay above the caption band or at low opacity below it,
 * so captions and diagrams keep contrast. The floor line sits just under the feet baseline.
 */
export const BACKGROUNDS = [
  "plain",
  "grid",
  "bank",
  "store",
  "office",
  "street",
  "sky",
  "kitchen",
  "airport",
  "lab",
] as const;
export type BackgroundId = (typeof BACKGROUNDS)[number];
export type BackgroundPalette = Readonly<{ surface: string; muted: string; accent: string }>;

const scenery = (
  id: BackgroundId,
  { muted, accent }: BackgroundPalette,
  frame: CanvasGeometry["frame"],
): string => {
  const soft = `fill="${muted}" fill-opacity="0.55"`;
  const line = `stroke="${muted}" stroke-width="10" fill="none"`;
  switch (id) {
    case "plain":
      return "";
    case "grid": {
      const vertical = Array.from(
        { length: Math.floor(frame.width / 90) + 1 },
        (_, i) => `M${i * 90} 0V${frame.height}`,
      ).join("");
      const horizontal = Array.from(
        { length: Math.floor(frame.height / 90) + 1 },
        (_, i) => `M0 ${i * 90}H${frame.width}`,
      ).join("");
      return `<path d="${vertical}${horizontal}" stroke="${muted}" stroke-width="2" stroke-opacity="0.6"/>`;
    }
    case "bank":
      return `<path d="M140 560 L540 380 L940 560 Z" ${soft}/><rect x="160" y="580" width="760" height="30" ${soft}/>${[220, 400, 580, 760].map((x) => `<rect x="${x}" y="630" width="90" height="500" ${soft}/>`).join("")}<rect x="140" y="1130" width="800" height="40" ${soft}/>`;
    case "store":
      return `${[520, 720, 920].map((y) => `<rect x="80" y="${y}" width="920" height="18" ${soft}/>`).join("")}${[180, 340, 500, 660, 820].map((x, i) => `<rect x="${x}" y="${440 + (i % 2) * 200}" width="90" height="${80 - (i % 3) * 14}" rx="10" fill="${accent}" fill-opacity="0.18"/>`).join("")}`;
    case "office":
      return `<rect x="640" y="420" width="300" height="220" rx="14" ${line}/><path d="M700 600 L760 520 L820 570 L900 470" ${line}/><rect x="120" y="860" width="420" height="24" ${soft}/><rect x="160" y="884" width="20" height="300" ${soft}/><rect x="480" y="884" width="20" height="300" ${soft}/>`;
    case "street":
      return `<rect x="80" y="520" width="240" height="670" ${soft}/><rect x="360" y="400" width="300" height="790" ${soft}/><rect x="700" y="600" width="280" height="590" ${soft}/>${[120, 200, 400, 500, 580, 740, 840].map((x, i) => `<rect x="${x}" y="${640 + (i % 3) * 140}" width="50" height="70" fill="${accent}" fill-opacity="0.2"/>`).join("")}`;
    case "sky":
      return `<circle cx="820" cy="460" r="110" fill="${accent}" fill-opacity="0.22"/><path d="M180 620 q40 -70 110 -40 q50 -60 120 0 q60 0 60 50 h-290 z" ${soft}/><path d="M560 820 q30 -50 90 -30 q40 -50 100 0 q50 0 50 40 h-240 z" ${soft}/>`;
    case "kitchen":
      return `<rect x="80" y="900" width="920" height="30" ${soft}/><rect x="120" y="420" width="360" height="260" rx="10" ${line}/><line x1="300" y1="420" x2="300" y2="680" stroke="${muted}" stroke-width="10"/><rect x="620" y="430" width="300" height="200" rx="100" fill="${accent}" fill-opacity="0.15"/>`;
    case "airport":
      return `<rect x="80" y="400" width="920" height="360" rx="20" ${line}/><path d="M260 580 h460 l60 -40 h40 l-40 60 l40 60 h-40 l-60 -40 h-460 z" fill="${accent}" fill-opacity="0.18"/>${[160, 360, 560, 760].map((x) => `<rect x="${x}" y="820" width="140" height="30" rx="8" ${soft}/>`).join("")}`;
    case "lab":
      return `<rect x="80" y="880" width="920" height="26" ${soft}/><path d="M220 880 v-160 l-60 -140 h160 l-60 140 v160 z" ${soft}/><circle cx="700" cy="560" r="70" ${line}/><circle cx="820" cy="660" r="46" ${line}/><line x1="750" y1="610" x2="790" y2="630" stroke="${muted}" stroke-width="10"/>`;
  }
};

/**
 * Portrait scenery is drawn in 1080x1920 coordinates just above the floor line. Landscape reuses
 * those shapes, centred and dropped onto its own floor line, so the setting stays behind the
 * stage; the grid (a full-frame pattern) is drawn at frame size instead.
 */
export const renderBackground = (
  id: BackgroundId,
  palette: BackgroundPalette,
  geometry: CanvasGeometry = PORTRAIT_GEOMETRY,
): string => {
  const { frame } = geometry;
  const floorY = geometry.baselineY + 10;
  const shapes = scenery(id, palette, frame);
  const placed =
    geometry.canvas === "portrait" || id === "grid" || shapes === ""
      ? shapes
      : `<g transform="translate(${(frame.width - PORTRAIT_GEOMETRY.frame.width) / 2},${floorY - (PORTRAIT_GEOMETRY.baselineY + 10)})">${shapes}</g>`;
  return `<g data-background="${id}"><rect width="${frame.width}" height="${frame.height}" fill="${palette.surface}"/>${placed}<line x1="0" y1="${floorY}" x2="${frame.width}" y2="${floorY}" stroke="${palette.muted}" stroke-width="6"/></g>`;
};
