import { escapeXml, n } from "./layout.js";

/** Simple, bold objects (~160 px) that carry meaning next to a character or a diagram. */
export const PROPS = [
  "money_stack",
  "coin",
  "phone",
  "laptop",
  "shopping_cart",
  "milk_carton",
  "airplane",
  "clock",
  "chart_up",
  "chart_down",
  "question_mark",
  "lightbulb",
  "shield",
  "globe",
  "document",
  "card",
] as const;
export type PropId = (typeof PROPS)[number];
export type PropPalette = Readonly<{ line: string; accent: string }>;

const shape = (type: PropId, { line, accent }: PropPalette): string => {
  const s = `stroke="${line}" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"`;
  const filled = `fill="${accent}" ${s}`;
  const open = `fill="none" ${s}`;
  switch (type) {
    case "money_stack":
      return (
        [30, 0, -30]
          .map((y) => `<rect x="-80" y="${y - 20}" width="160" height="44" rx="6" ${filled}/>`)
          .join("") +
        `<circle cx="0" cy="-48" r="12" fill="none" stroke="${line}" stroke-width="6"/>`
      );
    case "coin":
      return `<circle r="70" ${filled}/><text y="26" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="76" fill="${line}">$</text>`;
    case "phone":
      return `<rect x="-45" y="-80" width="90" height="160" rx="16" ${filled}/><line x1="-14" y1="60" x2="14" y2="60" ${s}/>`;
    case "laptop":
      return `<rect x="-70" y="-70" width="140" height="96" rx="8" ${filled}/><path d="M-95 26 h190 l-16 30 h-158 z" fill="none" ${s}/>`;
    case "shopping_cart":
      return `<path d="M-90 -60 h30 l24 90 h100 l20 -70 h-130" ${open}/><circle cx="-24" cy="60" r="14" ${filled}/><circle cx="54" cy="60" r="14" ${filled}/>`;
    case "milk_carton":
      return `<path d="M-50 -40 l20 -40 h60 l20 40 v120 h-100 z" ${filled}/><path d="M-50 -40 h100" ${open}/><rect x="-26" y="0" width="52" height="40" rx="6" fill="#ffffff" stroke="${line}" stroke-width="6"/>`;
    case "airplane":
      return `<path d="M-90 0 h150 l30 -14 q20 14 0 28 l-30 -14 M-10 0 l-40 -60 h24 l60 60 M-10 0 l-40 60 h24 l60 -60 M-80 0 l-20 -30 h16 l24 30" ${filled}/>`;
    case "clock":
      return `<circle r="72" fill="#ffffff" ${s}/><path d="M0 -44 V0 L32 22" ${open}/>`;
    case "chart_up":
      return `<path d="M-80 70 V-70 M-80 70 H80" ${open}/><path d="M-60 40 L-20 0 L10 20 L70 -50" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 -52 h32 v32" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "chart_down":
      return `<path d="M-80 70 V-70 M-80 70 H80" ${open}/><path d="M-60 -50 L-20 -10 L10 -30 L70 40" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/><path d="M40 42 h32 v-32" fill="none" stroke="${accent}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "question_mark":
      return `<text y="60" text-anchor="middle" font-family="Inter, sans-serif" font-weight="800" font-size="200" fill="${accent}" stroke="${line}" stroke-width="6" paint-order="stroke">?</text>`;
    case "lightbulb":
      return `<path d="M-40 20 a60 60 0 1 1 80 0 v30 h-80 z" ${filled}/><path d="M-30 70 h60" ${open}/>`;
    case "shield":
      return `<path d="M0 -80 L70 -50 V10 Q70 60 0 90 Q-70 60 -70 10 V-50 Z" ${filled}/><path d="M-26 6 l20 22 l34 -40" ${open}/>`;
    case "globe":
      return `<circle r="72" fill="#ffffff" ${s}/><ellipse rx="30" ry="72" ${open}/><path d="M-72 0 H72 M-60 -38 H60 M-60 38 H60" ${open}/>`;
    case "document":
      return `<path d="M-55 -80 h80 l30 30 v130 h-110 z" fill="#ffffff" ${s}/><path d="M-30 -30 h60 M-30 0 h60 M-30 30 h40" ${open}/>`;
    case "card":
      return `<rect x="-90" y="-56" width="180" height="112" rx="14" ${filled}/><rect x="-90" y="-30" width="180" height="22" fill="${line}"/>`;
  }
};

export const renderProp = (input: {
  type: PropId;
  x: number;
  y: number;
  scale?: number | undefined;
  label?: string | undefined;
  palette: PropPalette;
}): string => {
  const label = input.label?.trim()
    ? `<text y="130" text-anchor="middle" font-family="Inter, sans-serif" font-weight="700" font-size="40" fill="${input.palette.line}">${escapeXml(input.label.trim())}</text>`
    : "";
  return `<g data-prop="${input.type}" transform="translate(${n(input.x)},${n(input.y)}) scale(${n(input.scale ?? 1)})">${shape(input.type, input.palette)}${label}</g>`;
};
