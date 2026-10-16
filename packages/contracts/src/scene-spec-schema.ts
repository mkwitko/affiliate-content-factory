import { z } from "zod";

type Names = readonly [string, ...string[]];
/** Short-form storyboards stop at 40 scene indices; a long-form one may reach this cap. */
export const SHORT_FORM_MAX_SCENE_INDEX = 40;
export const LONG_FORM_MAX_SCENES = 150;
/**
 * The closed vocabulary a SceneSpec may use. Core passes its purposes, rig poses and actions,
 * props and backgrounds, so contracts never imports core and both callers (the MCP storyboard
 * tool and the local scene director) validate against the same schema.
 */
export type SceneSpecCatalog = Readonly<{
  purposes: Names;
  backgrounds: Names;
  poses: Names;
  expressions: Names;
  props: Names;
  actions: Names;
  emotions: Names;
  cameraMovements: Names;
  /** Shortest emote that still shows a start, a middle and an end. */
  emoteMinMs: number;
  /** Motion token ids (v2 slice 22); absent means the schema accepts no tokens. */
  motionTokens?: Names | undefined;
  /** Shot kinds (v2 slice 23); absent keeps wide, medium and close. */
  shots?: Names | undefined;
  /** Layout ids (v2 slice 23); absent means the schema accepts no layoutId. */
  layouts?: Names | undefined;
  /**
   * The cast and the niche's location, zone and anchor ids. When given they become enums, so a
   * grammar-constrained model cannot name an unknown one; absent keeps the id patterns.
   */
  characterKeys?: Names | undefined;
  locationIds?: Names | undefined;
  zoneIds?: Names | undefined;
  anchorIds?: Names | undefined;
  /** Highest scene index; defaults to the short-form 40. Long-form callers pass the long cap. */
  maxSceneIndex?: number | undefined;
}>;

const label = (max: number) => z.string().trim().min(1).max(max);
/** Diagrams that show words, not figures; shared by the scene and director plan schemas. */
const flowDiagram = (props: Names) =>
  z
    .object({
      kind: z.literal("flow"),
      nodes: z
        .array(
          z.object({ id: label(16), label: label(24), icon: z.enum(props).optional() }).strict(),
        )
        .min(2)
        .max(5),
      edges: z
        .array(z.object({ from: label(16), to: label(16), label: label(16).optional() }).strict())
        .min(1)
        .max(6),
    })
    .strict();
const timelineDiagram = z
  .object({
    kind: z.literal("timeline"),
    points: z
      .array(z.object({ label: label(16), at: label(12) }).strict())
      .min(2)
      .max(5),
  })
  .strict();
const beforeAfterDiagram = z
  .object({ kind: z.literal("before_after"), before: label(24), after: label(24) })
  .strict();

export const createSceneSpecSchema = (catalog: SceneSpecCatalog) => {
  const stagePosition = z.enum(["left", "center", "right"]);
  const claimRef = z.number().int().min(0).optional();
  const diagram = z.discriminatedUnion("kind", [
    flowDiagram(catalog.props),
    z
      .object({
        kind: z.literal("bar_compare"),
        items: z
          .array(
            z
              .object({
                label: label(16),
                value: z.number().finite().min(0),
                unit: z.string().max(8).optional(),
              })
              .strict(),
          )
          .min(2)
          .max(4),
        claimRef,
      })
      .strict(),
    z
      .object({
        kind: z.literal("counter"),
        from: z.number().finite(),
        to: z.number().finite(),
        unit: z.string().max(8).optional(),
        claimRef,
      })
      .strict(),
    timelineDiagram,
    beforeAfterDiagram,
    z
      .object({
        kind: z.literal("percent"),
        value: z.number().min(0).max(100),
        label: label(24),
        claimRef,
      })
      .strict(),
  ]);
  const atWord = z.number().int().min(0).max(400);
  const locationRef = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
  const idOf = (names: Names | undefined) => (names ? z.enum(names) : locationRef);
  const actionDuration = z.number().int().min(200).max(4_000).optional();
  // 0-based index into the scene's props (max 3) or overlays (max 2); existence is checked in core.
  const characterKey = catalog.characterKeys
    ? z.enum(catalog.characterKeys)
    : z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
  const targetIndex = z.number().int().min(0).max(2);
  const propTarget = z.object({ kind: z.literal("prop"), index: targetIndex }).strict();
  const diagramTarget = z.object({ kind: z.literal("diagram") }).strict();
  const overlayTarget = z.object({ kind: z.literal("overlay"), index: targetIndex }).strict();
  const actionTarget = z.discriminatedUnion("kind", [propTarget, diagramTarget, overlayTarget]);
  const lookTarget = z.discriminatedUnion("kind", [
    propTarget,
    diagramTarget,
    overlayTarget,
    z.object({ kind: z.literal("actor"), characterKey }).strict(),
  ]);
  // Motion budget category (v2 slice 16); absent counts as primary.
  const priority = z.enum(["primary", "secondary", "ambient"]).optional();
  const actionOptions = [
    z
      .object({
        type: z.literal("enter"),
        atWord,
        priority,
        from: z.enum(["left", "right"]),
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("exit"),
        atWord,
        priority,
        to: z.enum(["left", "right"]),
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("walk_to"),
        atWord,
        priority,
        to: stagePosition,
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("pose"),
        atWord,
        priority,
        pose: z.enum(catalog.poses),
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("expression"),
        atWord,
        priority,
        expression: z.enum(catalog.expressions),
      })
      .strict(),
    z.object({ type: z.literal("jump"), atWord, priority, durationMs: actionDuration }).strict(),
    z
      .object({ type: z.literal("react"), atWord, priority, mark: z.enum(["exclaim", "sparkle"]) })
      .strict(),
    z
      .object({
        type: z.literal("point_at"),
        atWord,
        priority,
        target: actionTarget,
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("look_at"),
        atWord,
        priority,
        target: lookTarget,
        durationMs: actionDuration,
      })
      .strict(),
    z
      .object({
        type: z.literal("emote"),
        atWord,
        priority,
        emotion: z.enum(catalog.emotions),
        durationMs: z.number().int().min(catalog.emoteMinMs).max(4_000).optional(),
      })
      .strict(),
  ] as const;
  const allowed = actionOptions.filter((option) =>
    catalog.actions.includes(option.shape.type.value),
  );
  if (allowed.length !== catalog.actions.length) throw new Error("scene_catalog_action_unknown");
  // The filtered list keeps the tuple's member types; only its length changed.
  const actorAction = z.discriminatedUnion("type", allowed as unknown as typeof actionOptions);
  return z
    .object({
      index: z
        .number()
        .int()
        .min(1)
        .max(catalog.maxSceneIndex ?? SHORT_FORM_MAX_SCENE_INDEX),
      fromChar: z.number().int().min(0),
      toChar: z.number().int().min(1),
      purpose: z.enum(catalog.purposes),
      background: z.enum(catalog.backgrounds),
      // stickman_motion only: a painted background asset. Existence, workspace and rights are
      // checked in core (createStoryboard); the scene director never sees or sets this field.
      backgroundAssetId: z.string().trim().min(1).max(200).optional(),
      actors: z
        .array(
          z
            .object({
              characterKey,
              pose: z.enum(catalog.poses),
              expression: z.enum(catalog.expressions),
              position: stagePosition,
              facing: z.enum(["left", "right"]).optional(),
              scale: z.number().min(0.6).max(1.4).optional(),
              // stickman_motion only: what the actor does, anchored to a narration word.
              actions: z.array(actorAction).max(6).optional(),
              // v2 slice 23: a location anchor id; resolved into position, facing and scale.
              anchorId: idOf(catalog.anchorIds).optional(),
              ...(catalog.motionTokens?.length
                ? {
                    motionTokens: z
                      .array(
                        z
                          .object({
                            token: z.enum(catalog.motionTokens as [string, ...string[]]),
                            atWord,
                            target: actionTarget.optional(),
                            version: z.literal(1).optional(),
                          })
                          .strict(),
                      )
                      .max(4)
                      .optional(),
                  }
                : {}),
            })
            .strict(),
        )
        .max(3),
      props: z
        .array(
          z
            .object({
              type: z.enum(catalog.props),
              position: z.enum(["left", "center", "right", "top"]),
              label: label(16).optional(),
            })
            .strict(),
        )
        .max(3),
      diagram: diagram.optional(),
      overlays: z
        .array(
          z
            .object({
              text: label(24),
              emphasis: z.boolean().optional(),
              position: z.enum(["top", "middle"]),
            })
            .strict(),
        )
        .max(2),
      camera: z
        .object({
          shot: z.enum((catalog.shots ?? ["wide", "medium", "close"]) as [string, ...string[]]),
          movement: z.enum(catalog.cameraMovements),
        })
        .strict(),
      transition: z.enum(["hard_cut", "fade", "wipe"]),
      captionMode: z.enum(["word", "line", "none"]),
      holdMode: z.enum(["moving", "intentional_still"]).optional(),
      locationId: idOf(catalog.locationIds).optional(),
      zoneId: idOf(catalog.zoneIds).optional(),
      lighting: z.enum(["day", "dusk", "night", "indoor_warm", "overcast"]).optional(),
      // v2 slice 32: the scene's narration as speaker lines (script character ranges).
      dialogue: z
        .array(
          z
            .object({
              speakerKey: z.union([characterKey, z.literal("narrator")]),
              fromChar: z.number().int().min(0),
              toChar: z.number().int().min(1),
              pauseBeforeMs: z.number().int().min(0).max(2_000).optional(),
              interruptsPrev: z.boolean().optional(),
              reactions: z
                .array(
                  z
                    .object({
                      reactorKey: characterKey,
                      atWord,
                      token: z.enum(
                        (catalog.motionTokens ?? ["POINT_BEAT"]) as [string, ...string[]],
                      ),
                      delayMs: z.number().int().min(0).max(1_000).optional(),
                    })
                    .strict(),
                )
                .max(3)
                .optional(),
            })
            .strict(),
        )
        .max(12)
        .optional(),
      ...(catalog.layouts?.length
        ? { layoutId: z.enum(catalog.layouts as [string, ...string[]]).optional() }
        : {}),
    })
    .strict();
};

/**
 * The director chooses whether each sentence segment starts a scene. The compiler derives exact
 * offsets; visual direction appears only at scene starts. An overlay names a word from its
 * scene, and core selects a short literal excerpt from the script, so on-screen text cannot be invented.
 * Props carry no label; a counter or percent diagram carries only a claimRef; there is no
 * layoutId, dialogue or backgroundAssetId. Pass the catalog
 * with the shots, cast and location ids the director may use.
 */
export const directorPlanSchema = (catalog: SceneSpecCatalog, segmentCount: number) => {
  const wordIndex = z.number().int().min(0).max(400);
  const scene = createSceneSpecSchema({ ...catalog, layouts: undefined });
  // Numeric diagrams name a claim; core copies the figure from it (claim visualization), so the
  // director never writes a number. Diagrams whose labels are words keep the scene schema.
  const claimRef = z.number().int().min(0).max(19);
  const diagram = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("counter"), claimRef }).strict(),
    z.object({ kind: z.literal("percent"), claimRef }).strict(),
    flowDiagram(catalog.props),
    timelineDiagram,
    beforeAfterDiagram,
  ]);
  const visual = scene
    .omit({
      index: true,
      fromChar: true,
      toChar: true,
      backgroundAssetId: true,
      dialogue: true,
      props: true,
      overlays: true,
      diagram: true,
    })
    .extend({
      diagram: diagram.optional(),
      props: z
        .array(
          z
            .object({
              type: z.enum(catalog.props),
              position: z.enum(["left", "center", "right", "top"]),
            })
            .strict(),
        )
        .max(3),
      overlays: z
        .array(
          z
            .object({
              anchorWord: z.string().trim().min(1).max(64),
              emphasis: z.boolean().optional(),
              position: z.enum(["top", "middle"]),
            })
            .strict(),
        )
        .max(2),
    })
    .strict();
  const entry = z.discriminatedUnion("newScene", [
    z.object({ newScene: z.literal(true), visual }).strict(),
    z.object({ newScene: z.literal(false) }).strict(),
  ]);
  return z.object({ segments: z.array(entry).length(segmentCount) }).strict();
};
export type DirectorPlan = z.infer<ReturnType<typeof directorPlanSchema>>;
export type DirectorPlanSegment = DirectorPlan["segments"][number];

/**
 * JSON Schema for llama-server's response_format. The root is an object ({ segments }) because
 * OpenAI-style structured output expects one; `$schema` is dropped because llama.cpp's grammar
 * builder does not use it. The Zod schema stays the source of truth: output is parsed with
 * directorPlanSchema after decoding.
 */
export const sceneDirectorJsonSchema = (
  catalog: SceneSpecCatalog,
  segmentCount: number,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(z.toJSONSchema(directorPlanSchema(catalog, segmentCount))).filter(
      ([key]) => key !== "$schema",
    ),
  ) as Record<string, unknown>;
