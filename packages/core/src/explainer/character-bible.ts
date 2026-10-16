import { type ActingProfile, readActingProfile } from "./acting.js";

/**
 * CharacterBible (Stickman v2 spec section 11.1, slice 19): who a recurring character is, on the
 * niche cast, versioned. The body archetype is a set of multipliers on the one stick-v1 rig
 * topology (no new joints); identity never depends on colour. Acting (slice 20) is optional
 * here and neutral when absent.
 */
export const ARCHETYPES = ["lanky", "average", "heavy", "tiny", "tall_strong", "elder"] as const;
export type Archetype = (typeof ARCHETYPES)[number];
export const HEAD_SHAPES = [
  "circle",
  "oval_tall",
  "oval_wide",
  "square_round",
  "egg",
  "bean",
] as const;
export type HeadShape = (typeof HEAD_SHAPES)[number];
export const BIBLE_ROLES = ["lead", "foil", "mentor", "kid", "rival", "narrator"] as const;
export type BibleRole = (typeof BIBLE_ROLES)[number];

/** Multipliers the rig applies; all 1 (and circle) draws today's figure byte for byte. */
export type RigBuild = Readonly<{
  limb: number;
  torso: number;
  head: number;
  stroke: number;
  /** Degrees added to every pose's lean (an elder's stoop). */
  lean: number;
  /** Head outline scale, x and y. */
  headShape: Readonly<{ rx: number; ry: number }>;
}>;

/** HYPOTHESIS multipliers, tuned on the silhouette test of the first cast. */
export const ARCHETYPE_BUILD: Readonly<Record<Archetype, Omit<RigBuild, "headShape">>> =
  Object.freeze({
    lanky: { limb: 1.14, torso: 1.12, head: 0.88, stroke: 0.85, lean: 0 },
    average: { limb: 1, torso: 1, head: 1, stroke: 1, lean: 0 },
    heavy: { limb: 0.84, torso: 0.9, head: 1.12, stroke: 1.9, lean: 0 },
    tiny: { limb: 0.72, torso: 0.72, head: 1.12, stroke: 0.9, lean: 0 },
    tall_strong: { limb: 1.1, torso: 1.18, head: 0.95, stroke: 1.4, lean: -2 },
    elder: { limb: 0.94, torso: 0.92, head: 1, stroke: 1, lean: 7 },
  });
export const HEAD_SHAPE_SCALE: Readonly<Record<HeadShape, Readonly<{ rx: number; ry: number }>>> =
  Object.freeze({
    circle: { rx: 1, ry: 1 },
    oval_tall: { rx: 0.86, ry: 1.14 },
    oval_wide: { rx: 1.16, ry: 0.88 },
    square_round: { rx: 1.06, ry: 0.98 },
    egg: { rx: 0.92, ry: 1.08 },
    bean: { rx: 1.1, ry: 0.94 },
  });

export type CharacterBible = Readonly<{
  version: number;
  role: BibleRole;
  body: Readonly<{
    archetype: Archetype;
    head: HeadShape;
    /** Overall size multiplier on the actor scale (height class). */
    scale: number;
    signature?: string | undefined;
    minor?: string | undefined;
  }>;
  voice?: Readonly<{
    voiceId?: string;
    speed?: number;
    pauseMs?: number;
    register?: "plain" | "formal" | "slangy";
  }>;
  want?: string;
  flaw?: string;
  traits?: readonly string[];
  tics?: readonly string[];
  relationships?: readonly Readonly<{
    otherId: string;
    kind: "friend" | "rival" | "family" | "boss" | "crush";
  }>[];
  defaults?: Readonly<{
    enterFrom?: "left" | "right";
    facing?: "left" | "right";
    homeLocationId?: string;
  }>;
  /** ActingProfile (slice 20); absent acts neutral. Read only with the motion grammar on. */
  acting?: ActingProfile;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, max) : undefined;
const texts = (value: unknown, count: number): readonly string[] | undefined =>
  Array.isArray(value)
    ? value.flatMap((entry) => (text(entry, 80) ? [text(entry, 80) as string] : [])).slice(0, count)
    : undefined;

/** Reads a stored bible; null without a valid version, role and body. */
export const readCharacterBible = (value: unknown): CharacterBible | null => {
  if (!isRecord(value) || !isRecord(value.body)) return null;
  const { body } = value;
  if (
    typeof value.version !== "number" ||
    !(BIBLE_ROLES as readonly unknown[]).includes(value.role) ||
    !(ARCHETYPES as readonly unknown[]).includes(body.archetype) ||
    !(HEAD_SHAPES as readonly unknown[]).includes(body.head)
  )
    return null;
  const scale =
    typeof body.scale === "number" && body.scale >= 0.6 && body.scale <= 1.4 ? body.scale : 1;
  const voice = isRecord(value.voice) ? value.voice : undefined;
  const defaults = isRecord(value.defaults) ? value.defaults : undefined;
  const side = (v: unknown) => (v === "left" || v === "right" ? v : undefined);
  const acting = readActingProfile(value.acting) ?? undefined;
  return Object.freeze({
    version: Math.max(1, Math.floor(value.version)),
    role: value.role as BibleRole,
    body: Object.freeze({
      archetype: body.archetype as Archetype,
      head: body.head as HeadShape,
      scale,
      ...(text(body.signature, 40) ? { signature: text(body.signature, 40) } : {}),
      ...(text(body.minor, 40) ? { minor: text(body.minor, 40) } : {}),
    }),
    ...(voice
      ? {
          voice: Object.freeze({
            ...(typeof voice.voiceId === "string" ? { voiceId: voice.voiceId } : {}),
            ...(typeof voice.speed === "number" ? { speed: voice.speed } : {}),
            ...(typeof voice.pauseMs === "number" ? { pauseMs: voice.pauseMs } : {}),
            ...(voice.register === "plain" ||
            voice.register === "formal" ||
            voice.register === "slangy"
              ? { register: voice.register }
              : {}),
          }),
        }
      : {}),
    ...(text(value.want, 200) ? { want: text(value.want, 200) } : {}),
    ...(text(value.flaw, 200) ? { flaw: text(value.flaw, 200) } : {}),
    ...(texts(value.traits, 3) ? { traits: texts(value.traits, 3) } : {}),
    ...(texts(value.tics, 2) ? { tics: texts(value.tics, 2) } : {}),
    ...(Array.isArray(value.relationships)
      ? {
          relationships: value.relationships.flatMap((entry) =>
            isRecord(entry) &&
            typeof entry.otherId === "string" &&
            ["friend", "rival", "family", "boss", "crush"].includes(String(entry.kind))
              ? [{ otherId: entry.otherId, kind: entry.kind as "friend" }]
              : [],
          ),
        }
      : {}),
    ...(defaults
      ? {
          defaults: Object.freeze({
            ...(side(defaults.enterFrom) ? { enterFrom: side(defaults.enterFrom) } : {}),
            ...(side(defaults.facing) ? { facing: side(defaults.facing) } : {}),
            ...(typeof defaults.homeLocationId === "string"
              ? { homeLocationId: defaults.homeLocationId }
              : {}),
          }),
        }
      : {}),
    ...(acting ? { acting } : {}),
  }) as CharacterBible;
};

export const rigBuildFor = (bible: CharacterBible): RigBuild =>
  Object.freeze({
    ...ARCHETYPE_BUILD[bible.body.archetype],
    headShape: HEAD_SHAPE_SCALE[bible.body.head],
  });
