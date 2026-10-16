import { BACKGROUNDS, type BackgroundId } from "./backgrounds.js";
import { type Canvas, geometryFor, positionX, type StagePosition } from "./layout.js";
import { LAYOUT_IDS, type LayoutId, LAYOUTS, layoutMismatch } from "./layouts.js";
import type { SceneSpec } from "./scene-spec.js";
import { SHOT_KINDS, SHOT_RULES, type ShotKind } from "./shots.js";

/**
 * Locations (Stickman v2 spec 12, slice 23): a recurring place a niche owns, with camera zones
 * and anchors a director names by id instead of coordinates. A scene that names a location is
 * resolved, when the storyboard is created, into today's fields (background, painted plate,
 * actor position, facing, scale), so the stored storyboard and the render show the same picture.
 */
export type CameraZone = Readonly<{
  id: string;
  /** Plate crop (slice 24): centre as frame fractions and zoom; stored now, applied later. */
  crop: Readonly<{ cx: number; cy: number; zoom: number }>;
  allowedShots: readonly ShotKind[];
  maxActors: number;
  layouts: readonly LayoutId[];
}>;
export type LocationAnchor = Readonly<{
  id: string;
  /** Frame fractions. */
  x: number;
  y: number;
  scale: number;
  facing: "left" | "right";
  pose: "stand" | "sit" | "lean";
}>;
export const LOCATION_LIGHTINGS = ["day", "dusk", "night", "indoor_warm", "overcast"] as const;
export type LocationLighting = (typeof LOCATION_LIGHTINGS)[number];
export type LightingGrade = Readonly<{
  tint: string;
  tintAlpha: number;
  shadowAlpha: number;
  vignette: number;
}>;
export type Location = Readonly<{
  id: string;
  version: number;
  name: string;
  plate: Readonly<{ assetId?: string | undefined; overscan: number }>;
  proceduralFallback: BackgroundId;
  zones: readonly CameraZone[];
  anchors: readonly LocationAnchor[];
  lighting?:
    | Readonly<
        Partial<Record<"day" | "dusk" | "night" | "indoor_warm" | "overcast", LightingGrade>>
      >
    | undefined;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : null;
const frac = (value: unknown, fallback: number) =>
  typeof value === "number" && value >= 0 && value <= 1 ? value : fallback;

const readZone = (value: unknown): CameraZone | null => {
  if (!isRecord(value) || !idOf(value.id)) return null;
  const crop = isRecord(value.crop) ? value.crop : {};
  const shots = Array.isArray(value.allowedShots)
    ? value.allowedShots.filter((s): s is ShotKind =>
        (SHOT_KINDS as readonly unknown[]).includes(s),
      )
    : [];
  const layouts = Array.isArray(value.layouts)
    ? value.layouts.filter((l): l is LayoutId => (LAYOUT_IDS as readonly unknown[]).includes(l))
    : [];
  return Object.freeze({
    id: value.id as string,
    crop: Object.freeze({
      cx: frac(crop.cx, 0.5),
      cy: frac(crop.cy, 0.5),
      zoom: typeof crop.zoom === "number" && crop.zoom >= 1 && crop.zoom <= 3 ? crop.zoom : 1,
    }),
    allowedShots: shots.length ? shots : [...SHOT_KINDS],
    maxActors:
      typeof value.maxActors === "number"
        ? Math.max(0, Math.min(3, Math.floor(value.maxActors)))
        : 3,
    layouts: layouts.length ? layouts : [...LAYOUT_IDS],
  });
};
const readAnchor = (value: unknown): LocationAnchor | null => {
  if (!isRecord(value) || !idOf(value.id)) return null;
  return Object.freeze({
    id: value.id as string,
    x: frac(value.x, 0.5),
    y: frac(value.y, 0.61),
    scale:
      typeof value.scale === "number" && value.scale >= 0.6 && value.scale <= 1.4 ? value.scale : 1,
    facing: value.facing === "left" ? "left" : "right",
    pose: value.pose === "sit" || value.pose === "lean" ? value.pose : "stand",
  });
};

const isHexColour = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
/** Grades are re-checked on read: the tint goes into SVG, so only a hex colour passes. */
const readLighting = (value: unknown): Location["lighting"] => {
  if (!isRecord(value)) return undefined;
  const grades = Object.fromEntries(
    LOCATION_LIGHTINGS.flatMap((key) => {
      const grade = value[key];
      if (!isRecord(grade) || !isHexColour(grade.tint)) return [];
      return [
        [
          key,
          Object.freeze({
            tint: grade.tint,
            tintAlpha: frac(grade.tintAlpha, 0),
            shadowAlpha: frac(grade.shadowAlpha, 0),
            vignette: frac(grade.vignette, 0),
          }),
        ],
      ];
    }),
  );
  return Object.keys(grades).length ? Object.freeze(grades) : undefined;
};

/** A niche's stored locations (explainer.locations); invalid entries are dropped. */
export const readLocations = (value: unknown): readonly Location[] =>
  Array.isArray(value)
    ? value.flatMap((entry): Location[] => {
        if (!isRecord(entry) || !idOf(entry.id) || typeof entry.name !== "string") return [];
        if (!(BACKGROUNDS as readonly unknown[]).includes(entry.proceduralFallback)) return [];
        const plate = isRecord(entry.plate) ? entry.plate : {};
        const zones = Array.isArray(entry.zones)
          ? entry.zones.flatMap((z) => readZone(z) ?? [])
          : [];
        const anchors = Array.isArray(entry.anchors)
          ? entry.anchors.flatMap((a) => readAnchor(a) ?? [])
          : [];
        return [
          Object.freeze({
            id: entry.id as string,
            version: typeof entry.version === "number" ? Math.max(1, Math.floor(entry.version)) : 1,
            name: entry.name.slice(0, 80),
            plate: Object.freeze({
              ...(typeof plate.assetId === "string" && plate.assetId.length > 0
                ? { assetId: plate.assetId }
                : {}),
              overscan:
                typeof plate.overscan === "number" && plate.overscan >= 1 ? plate.overscan : 1,
            }),
            proceduralFallback: entry.proceduralFallback as BackgroundId,
            zones,
            anchors,
            ...(() => {
              const lighting = readLighting(entry.lighting);
              return lighting ? { lighting } : {};
            })(),
          }),
        ];
      })
    : [];

/** Anchor lints (spec 12): left anchors face right, right anchors face left (180-degree line). */
export const locationWarnings = (location: Location): readonly string[] =>
  location.anchors.flatMap((anchor) =>
    (anchor.x < 0.45 && anchor.facing === "left") || (anchor.x > 0.55 && anchor.facing === "right")
      ? [`anchor_faces_out:${location.id}:${anchor.id}`]
      : [],
  );

export type LocationRejection =
  | "location_unknown"
  | "zone_unknown"
  | "zone_shot_not_allowed"
  | "zone_capacity"
  | "zone_layout_not_allowed"
  | "anchor_unknown"
  | "layout_unknown";

const STAGES: readonly StagePosition[] = ["left", "center", "right"];
/** Anchor x is a fraction of frame width, so it maps onto whichever canvas the scene uses. */
const nearestStage = (x: number, canvas?: Canvas): StagePosition => {
  const geo = geometryFor(canvas);
  return STAGES.reduce((best, stage) =>
    Math.abs(positionX(stage, geo) - x * geo.frame.width) <
    Math.abs(positionX(best, geo) - x * geo.frame.width)
      ? stage
      : best,
  );
};

/**
 * Resolves a scene's location ids into today's fields. A scene without `locationId` (and
 * without anchors) comes back unchanged; explicit fields the scene already set win.
 */
export const resolveLocationScene = (
  scene: SceneSpec,
  locations: readonly Location[],
  canvas?: Canvas,
):
  | Readonly<{ ok: true; scene: SceneSpec }>
  | Readonly<{ ok: false; reason: LocationRejection }> => {
  if (scene.layoutId !== undefined && !(LAYOUT_IDS as readonly string[]).includes(scene.layoutId))
    return { ok: false, reason: "layout_unknown" };
  if (scene.locationId === undefined) {
    if (scene.zoneId !== undefined || scene.actors.some((actor) => actor.anchorId !== undefined))
      return { ok: false, reason: "location_unknown" };
    return { ok: true, scene };
  }
  const location = locations.find((entry) => entry.id === scene.locationId);
  if (!location) return { ok: false, reason: "location_unknown" };
  if (scene.zoneId !== undefined) {
    const zone = location.zones.find((entry) => entry.id === scene.zoneId);
    if (!zone) return { ok: false, reason: "zone_unknown" };
    if (!zone.allowedShots.includes(scene.camera.shot))
      return { ok: false, reason: "zone_shot_not_allowed" };
    if (scene.actors.length > zone.maxActors) return { ok: false, reason: "zone_capacity" };
    if (scene.layoutId !== undefined && !zone.layouts.includes(scene.layoutId))
      return { ok: false, reason: "zone_layout_not_allowed" };
  }
  const actors = [];
  for (const actor of scene.actors) {
    if (actor.anchorId === undefined) {
      actors.push(actor);
      continue;
    }
    const anchor = location.anchors.find((entry) => entry.id === actor.anchorId);
    if (!anchor) return { ok: false, reason: "anchor_unknown" };
    actors.push({
      ...actor,
      position: nearestStage(anchor.x, canvas),
      facing: actor.facing ?? anchor.facing,
      scale: actor.scale ?? anchor.scale,
      ...(anchor.pose === "sit" && actor.pose === "neutral" ? { pose: "sitting" as const } : {}),
    });
  }
  return {
    ok: true,
    scene: {
      ...scene,
      background: location.proceduralFallback,
      ...(scene.backgroundAssetId === undefined && location.plate.assetId
        ? { backgroundAssetId: location.plate.assetId }
        : {}),
      actors,
    },
  };
};

/** Layout fit (validator): a scene that declares a layout must match it. */
export const sceneLayoutMismatch = (scene: SceneSpec) =>
  scene.layoutId === undefined ? null : layoutMismatch(LAYOUTS[scene.layoutId], scene);

/** Shot-kind rules (validator): capacity and required prop per kind. */
export const shotRuleViolation = (scene: SceneSpec): "shot_capacity" | "shot_needs_prop" | null => {
  const rule = SHOT_RULES[scene.camera.shot];
  if (scene.actors.length < rule.minActors || scene.actors.length > rule.maxActors)
    return "shot_capacity";
  if (rule.needsProp && scene.props.length === 0) return "shot_needs_prop";
  return null;
};
