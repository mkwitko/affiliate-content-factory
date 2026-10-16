import { visualLanguageProfileSchema } from "@money-maker/contracts/visual-language-schema";
import { musicVolumes, reelMoods } from "@money-maker/core/assets/reel-music";
import { CAPTION_FONTS, CAPTION_PRESET_IDS } from "@money-maker/core/brand/caption-style";
import {
  AFFILIATE_BIBLE_LIMITS,
  AFFILIATE_BIBLE_VERSION,
} from "@money-maker/core/creatives/affiliate-character-bible";
import { NEUTRAL_ACTING } from "@money-maker/core/explainer/acting";
import { EXPLAINER_ART_STYLES } from "@money-maker/core/explainer/background-art";
import { BACKGROUNDS } from "@money-maker/core/explainer/backgrounds";
import { ARCHETYPES, BIBLE_ROLES, HEAD_SHAPES } from "@money-maker/core/explainer/character-bible";
import {
  BOTTOM_STYLES,
  HAIR_STYLES,
  TOP_STYLES,
} from "@money-maker/core/explainer/explainer-context";
import { LAYOUT_IDS } from "@money-maker/core/explainer/layouts";
import { LOCATION_LIGHTINGS } from "@money-maker/core/explainer/locations";
import { SHOT_KINDS } from "@money-maker/core/explainer/shots";
import { z } from "zod";

const MAX_CONTEXT_BYTES = 16_384;

const shortText = (max: number) => z.string().trim().min(1).max(max);
const stringList = (maxItems: number, maxLen: number) => z.array(shortText(maxLen)).max(maxItems);
const hexColour = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const wardrobePiece = (styles: readonly [string, ...string[]]) =>
  z.object({ style: z.enum(styles), colour: hexColour }).strict();

const lightingGrade = z
  .object({
    tint: hexColour,
    tintAlpha: z.number().min(0).max(1),
    shadowAlpha: z.number().min(0).max(1),
    vignette: z.number().min(0).max(1),
  })
  .strict();

const packagingPattern = z
  .object({
    id: z.string().regex(/^[A-Z]{2}\d{1,2}$/),
    label: shortText(60),
    description: shortText(300).optional(),
    example: shortText(120).optional(),
  })
  .strict();

export const brandKitOverrideSchema = z
  .object({
    logoLightAssetId: z.string().trim().min(1).max(200).optional(),
    logoDarkAssetId: z.string().trim().min(1).max(200).optional(),
    palette: z
      .object({
        primary: hexColour.optional(),
        secondary: hexColour.optional(),
        accent: hexColour.optional(),
        surface: hexColour.optional(),
        text: hexColour.optional(),
        muted: hexColour.optional(),
        dark: hexColour.optional(),
        light: hexColour.optional(),
      })
      .strict()
      .optional(),
    tokens: z
      .object({
        headlineMinPx: z.number().min(10).max(300).optional(),
        headlineMaxPx: z.number().min(10).max(300).optional(),
        bodyPx: z.number().min(10).max(200).optional(),
        weightHeadline: z.number().int().min(100).max(900).optional(),
        weightBody: z.number().int().min(100).max(900).optional(),
        radius: z.number().min(0.1).max(200).optional(),
        pillPadding: z.number().min(0.05).max(2).optional(),
        haloEm: z.number().min(0.01).max(1).optional(),
        shadowOpacity: z.number().min(0.01).max(1).optional(),
        disclosurePx: z.number().min(10).max(200).optional(),
      })
      .strict()
      .optional(),
    typography: z
      .object({
        family: z.literal("Inter").optional(),
        headingWeight: z.union([z.literal(700), z.literal(800)]).optional(),
        bodyWeight: z.union([z.literal(400), z.literal(500)]).optional(),
      })
      .strict()
      .optional(),
    mark: z
      .object({
        position: z.enum(["top-left", "top-right", "bottom-left"]).optional(),
        minWidth: z.number().int().min(1).max(1080).optional(),
        safeMargin: z.number().min(0).max(0.2).optional(),
      })
      .strict()
      .optional(),
    brandName: shortText(120).optional(),
    nicheLabel: shortText(100).optional(),
  })
  .strict();

export const brandContextSchema = z
  .object({
    mission: shortText(500).optional(),
    tone: shortText(200).optional(),
    principles: stringList(20, 200).optional(),
    editorialRules: stringList(20, 200).optional(),
    cta: shortText(200).optional(),
    affiliateDisclosure: shortText(500).optional(),
    brandKit: brandKitOverrideSchema.optional(),
  })
  .strict();

export const nicheContextSchema = z
  .object({
    promise: shortText(500).optional(),
    audience: shortText(500).optional(),
    pillars: stringList(20, 200).optional(),
    prioritize: stringList(20, 200).optional(),
    avoid: stringList(20, 200).optional(),
    angles: stringList(20, 200).optional(),
    voice: shortText(200).optional(),
    tagline: shortText(120).optional(),
    forbiddenPhrases: stringList(40, 80).optional(),
    // Media niches: publishing rhythm of the channel.
    cadence: z
      .object({
        longFormPerWeek: z.number().int().min(1).max(14),
        shortsPerLongForm: z.number().int().min(0).max(6),
      })
      .strict()
      .optional(),
    // Media niches: title and hook taxonomies and thumbnail rules that idea validation and
    // script review check against (read by readPackagingProfile).
    packaging: z
      .object({
        titlePatterns: z.array(packagingPattern).max(20).optional(),
        hookPatterns: z.array(packagingPattern).max(20).optional(),
        thumbnailRules: stringList(20, 200).optional(),
        maxOverlayWords: z.number().int().min(0).max(6).optional(),
      })
      .strict()
      .optional(),
    // Kokoro voice id (e.g. pf_dora) used for this niche's Reels; REEL_VOICE_DEFAULT otherwise.
    voiceId: z
      .string()
      .regex(/^[a-z]{2}_[a-z]+$/)
      .optional(),
    brandKit: brandKitOverrideSchema.optional(),
    // Setting shared by every story piece: home, city, routine, illustration style.
    storyWorld: shortText(1000).optional(),
    // Recurring illustrated cast for story pieces (protagonist, family, friends, pets);
    // referenceAssetIds point at imported character sheets (import_asset_* with role
    // "character") so every render keeps the same look.
    characters: z
      .array(
        z
          .object({
            name: shortText(60),
            role: z.enum(["main", "secondary", "pet"]).optional(),
            description: shortText(500),
            referenceAssetIds: z.array(z.string().trim().min(1).max(200)).max(4).optional(),
            // Media niches: a deterministic stickman rig drawn by the explainer renderer.
            key: z
              .string()
              .regex(/^[a-z][a-z0-9_]{0,31}$/)
              .optional(),
            rigId: z.literal("stick-v1").optional(),
            rigVersion: z.literal(1).optional(),
            palette: z
              .object({ line: hexColour, fill: hexColour, accent: hexColour })
              .strict()
              .optional(),
            accessory: z.enum(["glasses", "cap", "tie", "headphones"]).optional(),
            // Media niches: clothes the rig draws, from a closed catalog; every scene shows them.
            wardrobe: z
              .object({
                hair: wardrobePiece(HAIR_STYLES).optional(),
                top: wardrobePiece(TOP_STYLES).optional(),
                bottoms: wardrobePiece(BOTTOM_STYLES).optional(),
                head: z.enum(["standard", "big"]).optional(),
              })
              .strict()
              .optional(),
            // Kokoro voice id; the main character's voice narrates every episode.
            voiceId: z
              .string()
              .regex(/^[a-z]{2}_[a-z]+$/)
              .optional(),
            // Affiliate cartoon cast (Carla, Bia, Rafa): the typed look applied to every offer
            // scene prompt (offer-scenes.ts). Separate from the stickman `bible` below.
            affiliateBible: z
              .object({
                version: z.literal(AFFILIATE_BIBLE_VERSION),
                appearance: shortText(AFFILIATE_BIBLE_LIMITS.text),
                proportions: shortText(AFFILIATE_BIBLE_LIMITS.text),
                hair: shortText(AFFILIATE_BIBLE_LIMITS.text),
                wardrobe: shortText(AFFILIATE_BIBLE_LIMITS.text),
                palette: z.array(hexColour).max(AFFILIATE_BIBLE_LIMITS.palette),
                expressions: stringList(AFFILIATE_BIBLE_LIMITS.list, AFFILIATE_BIBLE_LIMITS.item),
                poses: stringList(AFFILIATE_BIBLE_LIMITS.list, AFFILIATE_BIBLE_LIMITS.item),
                forbiddenChanges: stringList(
                  AFFILIATE_BIBLE_LIMITS.list,
                  AFFILIATE_BIBLE_LIMITS.item,
                ),
                voiceId: z
                  .string()
                  .regex(/^[a-z]{2}_[a-z]+$/)
                  .optional(),
              })
              .strict()
              .optional(),
            // Media niches (v2 slice 19): who the character is; the body archetype and head
            // shape change the rig's proportions, so cast members read apart in silhouette.
            bible: z
              .object({
                version: z.number().int().min(1),
                role: z.enum(BIBLE_ROLES),
                body: z
                  .object({
                    archetype: z.enum(ARCHETYPES),
                    head: z.enum(HEAD_SHAPES),
                    scale: z.number().min(0.6).max(1.4).optional(),
                    signature: shortText(40).optional(),
                    minor: shortText(40).optional(),
                  })
                  .strict(),
                voice: z
                  .object({
                    voiceId: z
                      .string()
                      .regex(/^[a-z]{2}_[a-z]+$/)
                      .optional(),
                    speed: z.number().min(0.5).max(2).optional(),
                    pauseMs: z.number().int().min(0).max(2_000).optional(),
                    register: z.enum(["plain", "formal", "slangy"]).optional(),
                  })
                  .strict()
                  .optional(),
                want: shortText(200).optional(),
                flaw: shortText(200).optional(),
                traits: z.array(shortText(80)).max(3).optional(),
                tics: z.array(shortText(80)).max(2).optional(),
                relationships: z
                  .array(
                    z
                      .object({
                        otherId: z.string().max(32),
                        kind: z.enum(["friend", "rival", "family", "boss", "crush"]),
                      })
                      .strict(),
                  )
                  .max(8)
                  .optional(),
                defaults: z
                  .object({
                    enterFrom: z.enum(["left", "right"]).optional(),
                    facing: z.enum(["left", "right"]).optional(),
                    homeLocationId: z.string().max(64).optional(),
                  })
                  .strict()
                  .optional(),
                acting: z
                  .object(
                    Object.fromEntries(
                      Object.keys(NEUTRAL_ACTING).map((key) => [key, z.number().optional()]),
                    ) as Record<keyof typeof NEUTRAL_ACTING, z.ZodOptional<z.ZodNumber>>,
                  )
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
    // Caption look of every video of the niche; omitted keeps today's word_pop captions.
    captionTheme: z
      .object({
        preset: z.enum(CAPTION_PRESET_IDS).optional(),
        useBrandColors: z.boolean().optional(),
        font: z.enum(CAPTION_FONTS).optional(),
        weight: z.union([z.literal(700), z.literal(800), z.literal(900)]).optional(),
        size: z.number().int().min(40).max(96).optional(),
        baseColor: hexColour.optional(),
        highlightColor: hexColour.optional(),
        highlightMode: z.enum(["color_pop", "color", "karaoke_fill", "none"]).optional(),
        surface: z.enum(["outline", "box", "shadow"]).optional(),
        surfaceColor: hexColour.optional(),
        position: z.enum(["bottom", "lower_third", "center"]).optional(),
        maxWords: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
        uppercase: z.boolean().optional(),
      })
      .strict()
      .optional(),
    // Preferred background-music moods (ranked ahead of the post's mood) and level.
    music: z
      .object({
        moods: z.array(z.enum(reelMoods)).max(4).optional(),
        volume: z.enum(musicVolumes).optional(),
      })
      .strict()
      .optional(),
    // Brand logo overlay on the niche's videos; off unless enabled. Needs brandKit logo assets.
    videoMark: z
      .object({
        enabled: z.boolean(),
        opacity: z.number().min(0.4).max(0.9).optional(),
        position: z.enum(["top-left", "top-right", "bottom-left"]).optional(),
      })
      .strict()
      .optional(),
    // Media niches only: format band, caption grouping, music default and content series.
    explainer: z
      .object({
        format: z.enum(["short", "long"]).optional(),
        targetSeconds: z
          .object({
            min: z.number().int().min(10).max(900),
            max: z.number().int().min(10).max(900),
          })
          .strict()
          .refine((value) => value.min < value.max)
          .optional(),
        captionStyle: z
          .object({ maxWords: z.union([z.literal(2), z.literal(3), z.literal(4)]) })
          .strict()
          .optional(),
        musicPolicy: z.enum(["none", "optional"]).optional(),
        // Painted backgrounds and the rig line: flat_cartoon (clean lines) or sketch_watercolor
        // (hand-drawn figures). Omitted keeps the procedural look.
        style: z.enum(EXPLAINER_ART_STYLES).optional(),
        // Measured visual language (v2 slice 18): written from the accepted style frames only
        // (measure-style-frames); omitted keeps today's look.
        visualLanguage: visualLanguageProfileSchema.optional(),
        // Recurring places (v2 slice 23): scenes name a location, zone and anchors by id and
        // the storyboard resolves them into the background, painting and actor placement.
        locations: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                version: z.number().int().min(1).optional(),
                name: shortText(80),
                plate: z
                  .object({
                    assetId: z.string().trim().min(1).max(200).optional(),
                    overscan: z.number().min(1).max(3).optional(),
                  })
                  .strict()
                  .optional(),
                proceduralFallback: z.enum(BACKGROUNDS),
                zones: z
                  .array(
                    z
                      .object({
                        id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                        crop: z
                          .object({
                            cx: z.number().min(0).max(1),
                            cy: z.number().min(0).max(1),
                            zoom: z.number().min(1).max(3),
                          })
                          .strict()
                          .optional(),
                        allowedShots: z.array(z.enum(SHOT_KINDS)).max(8).optional(),
                        maxActors: z.number().int().min(0).max(3).optional(),
                        layouts: z.array(z.enum(LAYOUT_IDS)).max(15).optional(),
                      })
                      .strict(),
                  )
                  .max(6),
                anchors: z
                  .array(
                    z
                      .object({
                        id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
                        x: z.number().min(0).max(1),
                        y: z.number().min(0).max(1).optional(),
                        scale: z.number().min(0.6).max(1.4).optional(),
                        facing: z.enum(["left", "right"]),
                        pose: z.enum(["stand", "sit", "lean"]).optional(),
                      })
                      .strict(),
                  )
                  .max(8),
                // One grade per lighting, spelled out: ChatGPT rejects a record's propertyNames.
                lighting: z
                  .object(
                    Object.fromEntries(
                      LOCATION_LIGHTINGS.map((lighting) => [lighting, lightingGrade]),
                    ) as Record<(typeof LOCATION_LIGHTINGS)[number], typeof lightingGrade>,
                  )
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .max(12)
          .optional(),
        // Motion grammar (v2 slice 15): anticipation, overshoot, settle, arcs and moving holds.
        motionGrammar: z.boolean().optional(),
        // Compositing profile (v2 slice 14): every field optional, resolved against the default
        // that reproduces today's frames. Tunables with HYPOTHESIS defaults until the review.
        compositing: z
          .object({
            focalContrastTarget: z.number().min(0).max(1).optional(),
            backgroundChromaCap: z.number().min(0).max(2).optional(),
            actorHaloVarianceMax: z.number().min(0).max(1).optional(),
            valueTiers: z.array(z.number().min(0).max(1)).length(3).optional(),
            lighting: z
              .object({
                directionDeg: z.number().min(0).max(360).optional(),
                shadowStrength: z.number().min(0).max(3).optional(),
                shadowOffset: z.array(z.number().min(-80).max(80)).length(2).optional(),
              })
              .strict()
              .optional(),
            depth: z
              .object({
                far: z.number().min(0).max(2).optional(),
                mid: z.number().min(0).max(2).optional(),
                hero: z.number().min(0).max(2).optional(),
                near: z.number().min(0).max(2).optional(),
                farValuePull: z.number().min(0).max(1).optional(),
              })
              .strict()
              .optional(),
            rim: z
              .object({
                enabled: z.boolean(),
                widthPx: z.number().min(1).max(16).optional(),
                colour: z
                  .string()
                  .regex(/^#[0-9a-fA-F]{6}$/)
                  .optional(),
              })
              .strict()
              .optional(),
            farBlurPx: z.number().min(0).max(12).optional(),
          })
          .strict()
          .optional(),
        series: z
          .array(
            z
              .object({
                key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
                name: shortText(80),
                preferredHooks: z.array(z.string().max(40)).max(6).optional(),
                mainCharacterKey: z.string().max(32).optional(),
                diagramRequired: z.boolean().optional(),
                ctaRule: shortText(200).optional(),
              })
              .strict(),
          )
          .max(12)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const channelContextSchema = z
  .object({
    role: shortText(200).optional(),
    objective: shortText(500).optional(),
    structure: stringList(20, 200).optional(),
    textRules: stringList(20, 200).optional(),
    visualRules: stringList(20, 200).optional(),
    cta: stringList(10, 200).optional(),
    slideCount: z
      .object({ min: z.number().int().min(1).max(50), max: z.number().int().min(1).max(50) })
      .strict()
      .optional(),
    brandKit: brandKitOverrideSchema.optional(),
  })
  .strict();

export const withContextSizeLimit = <Schema extends z.ZodTypeAny>(schema: Schema) =>
  schema.refine((value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_CONTEXT_BYTES, {
    message: "Context payload exceeds the 16KB limit",
  });
