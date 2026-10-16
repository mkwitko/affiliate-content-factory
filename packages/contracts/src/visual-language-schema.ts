import { z } from "zod";

/**
 * MCP boundary schema for a niche's VisualLanguageProfile (v2 slice 18, spec 10.2). id and
 * version are required; everything else is optional and resolved against the FLAT_VECTOR
 * defaults in core. Compositing keeps its own schema (explainer.compositing) and may be nested.
 */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// Fixed-length arrays, not z.tuple: ChatGPT rejects the array-form `items` a tuple emits.
const pair = (min: number, max: number) =>
  z
    .array(z.number().min(min).max(max))
    .length(2)
    .refine(([a = 0, b = 0]) => a <= b);
const unit = z.number().min(0).max(1);
const state = z
  .object({
    satDelta: z.number().min(-1).max(1),
    valDelta: z.number().min(-1).max(1),
    hueDeg: z.number().min(-180).max(180),
  })
  .strict();

export const visualLanguageProfileSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    version: z.number().int().min(1).max(10_000),
    characterStyle: z.enum(["EXPRESSIVE_INK", "EDITORIAL_FLAT", "CINEMATIC_GRAPHIC"]).optional(),
    environmentStyle: z
      .enum(["FLAT_VECTOR", "CUTOUT_PAINTED", "GOUACHE_PAINTED", "DARK_GRAPHIC"])
      .optional(),
    line: z
      .object({
        strokePx: z.number().min(1).max(40).optional(),
        wobblePct: z.number().min(0).max(20).optional(),
        outline: z.boolean().optional(),
      })
      .strict()
      .optional(),
    palette: z
      .object({
        roles: z
          .object({
            bgFar: hex.optional(),
            bgMid: hex.optional(),
            ink: hex.optional(),
            hero: hex.optional(),
            foe: hex.optional(),
            accent: hex.optional(),
            light: hex.optional(),
            shadow: hex.optional(),
            textOn: hex.optional(),
            textPlate: hex.optional(),
          })
          .strict()
          .optional(),
        areaMax: z
          .object({ dominant: unit, secondary: unit, accent: unit })
          .partial()
          .strict()
          .optional(),
        chromaCap: z
          .object({ bg: z.number().min(0).max(2), character: z.number().min(0).max(2) })
          .partial()
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    value: z
      .object({ areaTarget: z.array(unit).length(3), minFocalDeltaL: unit })
      .partial()
      .strict()
      .optional(),
    type: z
      .object({
        captionPx: pair(12, 200),
        numberPx: pair(12, 400),
        maxWordsChunk: z.number().int().min(1).max(8),
        minContrast: z.number().min(1).max(21),
      })
      .partial()
      .strict()
      .optional(),
    composition: z
      .object({
        heroXFractions: z.array(unit).min(1).max(8),
        heroYRange: pair(0, 1),
        heroAreaPct: pair(0, 100),
      })
      .partial()
      .strict()
      .optional(),
    motion: z
      .object({
        durationClassesFrames: z.array(z.number().int().min(1).max(240)).min(1).max(16),
        anticipationPct: pair(0, 60),
        overshootPct: pair(0, 60),
        settleFrames: pair(0, 120),
        maxStaticFrames: z.number().int().min(1).max(3_600),
      })
      .partial()
      .strict()
      .optional(),
    colorScript: z
      .object({ hook: state, problem: state, explain: state, twist: state, resolve: state })
      .partial()
      .strict()
      .optional(),
    pacing: z
      .object({ changeEverySec: pair(0.5, 30), maxGapSec: z.number().min(0.5).max(60) })
      .partial()
      .strict()
      .optional(),
    // The compositing block is validated by the explainer.compositing schema in the API.
    compositing: z.looseObject({}).optional(),
  })
  .strict();
