import type { PixelBox } from "./creative-renderer.js";
import type { SubjectBox, SubjectKind } from "./in-scene-fidelity.js";

/**
 * Keeps in-scene overlay text off faces, heads and the product (owner feedback 2026-10-06).
 * Pure: the overlay measures its two stacks (top: logo + headline; bottom: price, body, CTA,
 * disclosure) and this picks where they go. The bottom stack never moves to the top: the
 * disclosure and CTA stay where viewers and platforms expect them.
 */
export type LayoutBlockId = "top" | "bottom";
export type Placement = "top" | "bottom" | "left-column" | "right-column";
export type PixelSubject = Readonly<{ kind: SubjectKind; box: PixelBox }>;
/** A measured stack; `items` are its drawn boxes relative to the stack's top-left corner. */
export type MeasuredBlock = Readonly<{ w: number; h: number; items: readonly PixelBox[] }>;
export type BlockChoice = Readonly<{
  placement: Placement;
  scale: number;
  /** Width the stack was laid out in (full area or a column). */
  width: number;
  /** Top stack only: headline on a solid white card because no placement was clear. */
  card: boolean;
  box: PixelBox;
}>;
/** A hard rule the chosen layout still breaks; `overlap` is the share of the subject region covered. */
export type SubjectCollision = Readonly<{
  block: LayoutBlockId;
  kind: SubjectKind;
  overlap: number;
}>;
export type SubjectLayout = Readonly<{
  top: BlockChoice;
  bottom: BlockChoice;
  collisions: readonly SubjectCollision[];
}>;

/** One table for every layout knob. */
export const SUBJECT_LAYOUT = Object.freeze({
  /** Font scale steps, largest first; the card fallback uses the last. */
  scales: Object.freeze([1, 0.9, 0.8]),
  /** Column width as a share of the text area. */
  columnShare: 0.55,
  /** Text may cover at most this share of the product box. */
  productOverlapMax: 0.05,
  /** Head and shoulders: the top share of a person box text must not touch. */
  headShare: 0.3,
  /** Shrinking one step costs less than moving the headline (1) or using a column (2). */
  scaleStepCost: 0.6,
  /** Fallback ranking: how bad a residual overlap of each kind is. */
  weight: Object.freeze({ face: 4, person: 2, product: 1 }),
});

const TOP_PLACEMENTS: readonly Placement[] = ["top", "bottom", "left-column", "right-column"];
const BOTTOM_PLACEMENTS: readonly Placement[] = ["bottom", "left-column", "right-column"];

const area = (box: PixelBox) => Math.max(0, box.w) * Math.max(0, box.h);
const intersection = (a: PixelBox, b: PixelBox): number =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Normalized 0..1000 boxes of a `source`-sized scene drawn with `fit: cover` on `canvas`. */
export const subjectsOnCanvas = (
  subjects: readonly SubjectBox[],
  source: Readonly<{ w: number; h: number }>,
  canvas: Readonly<{ w: number; h: number }>,
  /** "width": the scene spans the canvas width uncropped, centred (story frame of a feed scene). */
  fit: "cover" | "width" = "cover",
): readonly PixelSubject[] => {
  const s =
    fit === "width" ? canvas.w / source.w : Math.max(canvas.w / source.w, canvas.h / source.h);
  const dx = (source.w * s - canvas.w) / 2;
  const dy = (source.h * s - canvas.h) / 2;
  const px = (n: number, side: number, d: number, max: number) =>
    Math.min(max, Math.max(0, (n / 1000) * side * s - d));
  return subjects.map(({ kind, box: [x0, y0, x1, y1] }) => {
    const x = px(x0, source.w, dx, canvas.w);
    const y = px(y0, source.h, dy, canvas.h);
    return {
      kind,
      box: { x, y, w: px(x1, source.w, dx, canvas.w) - x, h: px(y1, source.h, dy, canvas.h) - y },
    };
  });
};

/** The region text must stay out of, and how much of it may be covered. */
const forbidden = (subject: PixelSubject): { region: PixelBox; allowed: number } =>
  subject.kind === "person"
    ? {
        region: { ...subject.box, h: subject.box.h * SUBJECT_LAYOUT.headShare },
        allowed: 0,
      }
    : {
        region: subject.box,
        allowed: subject.kind === "product" ? SUBJECT_LAYOUT.productOverlapMax : 0,
      };

const collisionsOf = (
  block: LayoutBlockId,
  items: readonly PixelBox[],
  subjects: readonly PixelSubject[],
): SubjectCollision[] =>
  subjects.flatMap((subject) => {
    const { region, allowed } = forbidden(subject);
    const size = area(region);
    if (size === 0) return [];
    const overlap = Math.min(
      1,
      items.reduce((sum, item) => sum + intersection(item, region), 0) / size,
    );
    return overlap > allowed ? [{ block, kind: subject.kind, overlap }] : [];
  });

const placementCost = (block: LayoutBlockId, placement: Placement): number =>
  placement === block ? 0 : placement === "bottom" ? 1 : 2;

/**
 * Picks a placement and scale per stack so no text box touches a face, a head or more than 5%
 * of the product. When nothing is clear, the headline goes on a white card at the smallest
 * scale in the least-overlapping placement, and what still collides is reported. Returns null
 * when no placement fits the area at all (the caller keeps its default layout).
 */
export const chooseSubjectLayout = (input: {
  area: PixelBox;
  gap: number;
  subjects: readonly PixelSubject[];
  measure: (
    block: LayoutBlockId,
    width: number,
    scale: number,
    card: boolean,
  ) => MeasuredBlock | null;
}): SubjectLayout | null => {
  const { area: bounds, gap, subjects } = input;
  const columnWidth = Math.round(bounds.w * SUBJECT_LAYOUT.columnShare);
  const widthOf = (placement: Placement) => (placement.endsWith("column") ? columnWidth : bounds.w);
  const xOf = (placement: Placement) =>
    placement === "right-column" ? bounds.x + bounds.w - columnWidth : bounds.x;
  const inside = (r: PixelBox) =>
    r.x >= bounds.x &&
    r.y >= bounds.y &&
    r.x + r.w <= bounds.x + bounds.w &&
    r.y + r.h <= bounds.y + bounds.h;
  const absolute = (box: PixelBox, items: readonly PixelBox[]) =>
    items.map((item) => ({ ...item, x: box.x + item.x, y: box.y + item.y }));

  type Option = { layout: SubjectLayout; cost: number; score: number };
  const options = (scales: readonly number[], card: boolean): Option[] => {
    const tops = TOP_PLACEMENTS.flatMap((placement) =>
      scales.flatMap((scale, step) => {
        const measured = input.measure("top", widthOf(placement), scale, card);
        return measured ? [{ placement, scale, step, measured }] : [];
      }),
    );
    const out: Option[] = [];
    for (const placement of BOTTOM_PLACEMENTS)
      scales.forEach((scale, step) => {
        const measured = input.measure("bottom", widthOf(placement), scale, false);
        if (!measured) return;
        const bottomBox = {
          x: xOf(placement),
          y: bounds.y + bounds.h - measured.h,
          w: measured.w,
          h: measured.h,
        };
        if (!inside(bottomBox)) return;
        const bottom: BlockChoice = {
          placement,
          scale,
          width: widthOf(placement),
          card: false,
          box: bottomBox,
        };
        const bottomHits = collisionsOf("bottom", absolute(bottomBox, measured.items), subjects);
        for (const top of tops) {
          const topBox = {
            x: xOf(top.placement),
            y: top.placement === "bottom" ? bottomBox.y - gap - top.measured.h : bounds.y,
            w: top.measured.w,
            h: top.measured.h,
          };
          if (!inside(topBox) || intersection(topBox, bottomBox) > 0) continue;
          const collisions = [
            ...collisionsOf("top", absolute(topBox, top.measured.items), subjects),
            ...bottomHits,
          ];
          out.push({
            layout: {
              top: {
                placement: top.placement,
                scale: top.scale,
                width: widthOf(top.placement),
                card,
                box: topBox,
              },
              bottom,
              collisions,
            },
            cost:
              placementCost("top", top.placement) +
              placementCost("bottom", placement) +
              (top.step + step) * SUBJECT_LAYOUT.scaleStepCost,
            score: collisions.reduce(
              (sum, hit) => sum + hit.overlap * SUBJECT_LAYOUT.weight[hit.kind],
              0,
            ),
          });
        }
      });
    return out;
  };
  // Stable: among equals the first enumerated option wins.
  const best = (list: Option[]) =>
    list.reduce<Option | null>(
      (a, b) =>
        a === null || b.score < a.score || (b.score === a.score && b.cost < a.cost) ? b : a,
      null,
    );
  const clear = best(
    options(SUBJECT_LAYOUT.scales, false).filter((option) => option.layout.collisions.length === 0),
  );
  if (clear) return clear.layout;
  return best(options(SUBJECT_LAYOUT.scales.slice(-1), true))?.layout ?? null;
};
