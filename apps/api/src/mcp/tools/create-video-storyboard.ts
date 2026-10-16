import { dialogueWarnings } from "@money-maker/core/explainer/dialogue";
import { narrationMsPerWord } from "@money-maker/core/explainer/script-guards";
import { sceneWordCount } from "@money-maker/core/explainer/scene-spec";
import { resolveLocationScene } from "@money-maker/core/explainer/locations";
import { motionBudgetHint } from "@money-maker/core/explainer/motion-budget";
import {
  characterVoiceId,
  resolveNarrationVoice,
  voiceMatchesLanguage,
  voiceSeparationWarnings,
} from "@money-maker/core/explainer/voice";
import { randomUUID } from "node:crypto";
import { evaluateJevShadow } from "@money-maker/core/decisions/jev-shadow";
import type { UserId } from "@money-maker/contracts";
import {
  createSceneSpecSchema,
  LONG_FORM_MAX_SCENES,
} from "@money-maker/contracts/scene-spec-schema";
import {
  CLIP_PROMPT_MAX,
  createStoryboard,
  type ClipScene,
  isClipScene,
  isSceneSpec,
  isSceneSpecRenderer,
  isSceneSpecStoryboard,
  type StoryboardScene,
} from "@money-maker/core/content/storyboard";
import { leastUsed } from "@money-maker/core/creatives/scene-bank";
import {
  EXPLAINER_BACKGROUND_ROLE,
  type ExplainerArtStyle,
  explainerBackgroundKey,
  locationPlateKey,
  isUsableBackground,
} from "@money-maker/core/explainer/background-art";
import { readExplainerContext } from "@money-maker/core/explainer/explainer-context";
import { STICK_V1_CATALOG } from "@money-maker/core/explainer/scene-director";
import { sceneSpecFindings } from "@money-maker/core/explainer/visual-qa/scene-graph";
import {
  SCENE_PURPOSES,
  type SceneSpec,
  sceneSpecWarnings,
} from "@money-maker/core/explainer/scene-spec";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const imageScene = z
  .object({
    index: z.number().int().min(1).max(40),
    fromChar: z.number().int().min(0),
    toChar: z.number().int().min(1),
    assetId: z.string().min(1).max(200),
    motion: z.enum(["static", "ken_burns_in", "ken_burns_out", "pan_left", "pan_right"]),
    captionMode: z.enum(["word", "line", "none"]),
  })
  .strict();
const clipScene = z
  .object({
    index: z.number().int().min(1).max(40),
    fromChar: z.number().int().min(0),
    toChar: z.number().int().min(1),
    clipPrompt: z.string().trim().min(1).max(CLIP_PROMPT_MAX),
    referenceAssetId: z.string().min(1).max(200).optional(),
    captionMode: z.enum(["word", "line", "none"]),
  })
  .strict();
const sceneSpec = createSceneSpecSchema({
  purposes: SCENE_PURPOSES,
  ...STICK_V1_CATALOG,
  // The core storyboard gate admits more than 12 scenes only for a long-form niche.
  maxSceneIndex: LONG_FORM_MAX_SCENES,
});
export const createVideoStoryboardInputSchema = z
  .object({
    workspaceId: z.uuid(),
    scriptId: z.string().min(1).max(200),
    // slideshow scenes reference image assets; stickman_still/stickman_motion scenes are
    // SceneSpecs; ai_clips scenes carry a generation prompt (spec 2026-09-30 scene clips).
    renderer: z.enum(["slideshow", "stickman_still", "stickman_motion", "ai_clips"]).optional(),
    scenes: z
      .array(z.union([imageScene, clipScene, sceneSpec]))
      .min(1)
      .max(LONG_FORM_MAX_SCENES),
    // Optional for SceneSpec renderers: the niche's main character (or niche) voice narrates.
    voiceId: z.string().trim().min(1).max(100).optional(),
    musicTrackId: z.string().trim().max(300).nullable().optional(),
    canvas: z.enum(["landscape", "portrait"]),
  })
  .strict();
const loadExplainer = async (
  deps: McpDependencies,
  workspaceId: NonNullable<ReturnType<typeof parseWorkspaceArgument>>,
  contentItemId: string,
) => {
  const item = await deps.contentRepository?.findContentItemForWorkspace({
    workspaceId,
    contentItemId,
  });
  const niche = item
    ? await deps.nicheRepository?.findForWorkspace({ workspaceId, nicheId: item.nicheId })
    : null;
  const context = niche ? readExplainerContext(niche) : null;
  return niche && context ? { nicheId: niche.id, context } : null;
};

/**
 * Fills each motion scene that names no painting from the niche bank: same setting and style,
 * usable (rights, active), least used, not one an earlier scene of this storyboard took. A
 * setting without a usable painting keeps its procedural background. The pick is stored in the
 * storyboard, so the reviewed storyboard and the render show the same picture.
 */
const fillBackgrounds = async (
  deps: McpDependencies,
  workspaceId: NonNullable<ReturnType<typeof parseWorkspaceArgument>>,
  nicheId: string,
  style: ExplainerArtStyle,
  scenes: readonly SceneSpec[],
): Promise<readonly SceneSpec[]> => {
  const repository = deps.assetRepository;
  if (!repository?.listByMetadata) return scenes;
  const taken: string[] = [];
  const filled: SceneSpec[] = [];
  // v2 slice 24: a location keeps one plate for the whole storyboard (zones crop it).
  const locationPlates = new Map<string, string>();
  for (const scene of scenes) {
    if (scene.backgroundAssetId !== undefined) {
      taken.push(scene.backgroundAssetId);
      filled.push(scene);
      continue;
    }
    if (scene.locationId !== undefined) {
      const known = locationPlates.get(scene.locationId);
      const plate =
        known ??
        leastUsed(
          (
            await repository.listByMetadata({
              workspaceId,
              role: EXPLAINER_BACKGROUND_ROLE,
              key: "sceneKey",
              value: locationPlateKey(nicheId, { locationId: scene.locationId, style }),
            })
          ).filter((asset) => isUsableBackground(asset, workspaceId)),
          [],
        )?.id;
      if (plate) {
        if (!known) locationPlates.set(scene.locationId, plate);
        filled.push({ ...scene, backgroundAssetId: plate });
        continue;
      }
    }
    const pool = (
      await repository.listByMetadata({
        workspaceId,
        role: EXPLAINER_BACKGROUND_ROLE,
        key: "sceneKey",
        value: explainerBackgroundKey(nicheId, { setting: scene.background, style }),
      })
    ).filter((asset) => isUsableBackground(asset, workspaceId));
    const choice = leastUsed(pool, taken);
    if (!choice) {
      filled.push(scene);
      continue;
    }
    taken.push(choice.id);
    await repository.updateMetadata?.({
      workspaceId,
      assetId: choice.id,
      patch: {
        usageCount: Number(choice.metadata?.usageCount ?? 0) + 1,
        lastUsedAt: new Date().toISOString(),
      },
    });
    filled.push({ ...scene, backgroundAssetId: choice.id });
  }
  return filled;
};

export const createVideoStoryboardTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createVideoStoryboardInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (
    !workspaceId ||
    !deps.editorialRepository ||
    !deps.assetRepository ||
    !deps.storyboardRepository
  )
    return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const script = await deps.editorialRepository.findScriptForWorkspace({
    workspaceId,
    scriptId: parsed.data.scriptId,
  });
  if (!script) return { ok: false, error: "CONTENT_NOT_FOUND" };
  const renderer = parsed.data.renderer ?? "slideshow";
  const requested = parsed.data.scenes as readonly (StoryboardScene | SceneSpec | ClipScene)[];
  if (renderer === "ai_clips") {
    const item = await deps.contentRepository?.findContentItemForWorkspace({
      workspaceId,
      contentItemId: script.contentItemId,
    });
    const niche = item
      ? await deps.nicheRepository?.findForWorkspace({ workspaceId, nicheId: item.nicheId })
      : null;
    const experiments = niche?.context?.["experiments"];
    if (
      typeof experiments !== "object" ||
      experiments === null ||
      (experiments as { allowTrialRenderers?: unknown }).allowTrialRenderers !== true
    )
      return { ok: false, error: "TRIAL_RENDERER_NOT_ENABLED" };
  }
  const loaded = isSceneSpecRenderer(renderer)
    ? await loadExplainer(deps, workspaceId, script.contentItemId)
    : null;
  const explainer = loaded?.context ?? null;
  if (isSceneSpecRenderer(renderer) && !explainer)
    return { ok: false, error: "NICHE_KIND_MISMATCH" };
  let voiceId = parsed.data.voiceId;
  if (explainer) {
    const voice = resolveNarrationVoice({
      explicit: voiceId,
      characters: explainer.characters,
      nicheVoiceId: explainer.voiceId,
    });
    if (!voice.ok) return { ok: false, error: `STORYBOARD_VOICE_INVALID:${voice.reason}` };
    if (!voiceMatchesLanguage(voice.voiceId, script.language))
      return { ok: false, error: "STORYBOARD_VOICE_INVALID:voice_language_mismatch" };
    voiceId = voice.voiceId;
  }
  if (!voiceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  // v2 slice 23: location, zone and anchor ids become today's fields before anything else.
  const located: (StoryboardScene | SceneSpec | ClipScene)[] = [];
  for (const entry of requested) {
    if (!isSceneSpec(entry)) {
      located.push(entry);
      continue;
    }
    const resolved = resolveLocationScene(entry, explainer?.locations ?? [], parsed.data.canvas);
    if (!resolved.ok)
      return { ok: false, error: `STORYBOARD_SCENE_INVALID:${entry.index}:${resolved.reason}` };
    located.push(resolved.scene);
  }
  // Only all-SceneSpec motion boards are filled; a mixed board still fails in createStoryboard.
  const scenes: readonly (StoryboardScene | SceneSpec | ClipScene)[] =
    renderer === "stickman_motion" && loaded?.context.style && located.every(isSceneSpec)
      ? await fillBackgrounds(deps, workspaceId, loaded.nicheId, loaded.context.style, located)
      : located;
  const ids = [
    ...new Set(
      scenes.flatMap((entry) =>
        isClipScene(entry)
          ? entry.referenceAssetId === undefined
            ? []
            : [entry.referenceAssetId]
          : isSceneSpec(entry)
            ? entry.backgroundAssetId === undefined
              ? []
              : [entry.backgroundAssetId]
            : [entry.assetId],
      ),
    ),
  ];
  const assets = await Promise.all(
    ids.map((assetId) => deps.assetRepository!.findForWorkspace({ workspaceId, assetId })),
  );
  if (assets.some((asset) => !asset))
    return { ok: false, error: "STORYBOARD_ASSET_INVALID:unknown" };
  try {
    const latest = await deps.storyboardRepository.findLatestForScript({
      workspaceId,
      scriptId: script.id,
    });
    const board = createStoryboard({
      id: randomUUID(),
      workspaceId,
      script,
      version: (latest?.version ?? 0) + 1,
      renderer,
      scenes: scenes as readonly StoryboardScene[] | readonly SceneSpec[] | readonly ClipScene[],
      characters: explainer?.characters ?? [],
      assets: assets.filter((asset) => asset !== null),
      voiceId,
      musicTrackId: parsed.data.musicTrackId ?? null,
      canvas: parsed.data.canvas,
      actorId,
      longForm: explainer?.format === "long",
    });
    const stored = await deps.storyboardRepository.create(board);
    await deps.audit?.record({
      action: "content.storyboard.created",
      workspaceId,
      actorUserId: actorId,
      targetType: "VideoStoryboard",
      targetId: stored.id,
      metadata: { scriptId: stored.scriptId, version: stored.version },
    });
    if (deps.decisionProvider && deps.audit) {
      const existingRoute =
        stored.renderer === "ai_clips"
          ? "CLOUD_PREMIUM"
          : stored.renderer.startsWith("stickman")
            ? "STICKMAN"
            : "STATIC_ONLY";
      await evaluateJevShadow(
        deps.decisionProvider,
        {
          name: "generation_route",
          state: {
            renderer: stored.renderer,
            sceneCount: stored.scenes.length,
            canvas: stored.canvas,
            language: script.language,
            referenceCount: stored.scenes.filter(
              (scene) => "referenceAssetId" in scene && scene.referenceAssetId,
            ).length,
          },
          existingChoice: existingRoute,
          validatorResult: "pass",
          finalAcceptedRoute: existingRoute,
        },
        async (evidence) => {
          await deps.audit?.record({
            action: "ai.decision.shadow_recorded",
            workspaceId,
            systemActor: "system:jev-shadow",
            targetType: "VideoStoryboard",
            targetId: stored.id,
            metadata: {
              schemaVersion: evidence.schemaVersion,
              name: evidence.name,
              existingChoice: evidence.existingChoice,
              validatorResult: evidence.validatorResult,
              finalAcceptedRoute: evidence.finalAcceptedRoute,
              status: evidence.status,
              requestedModel: evidence.requestedModel ?? "",
              resolvedModel: evidence.resolvedModel ?? "",
              answerJson: JSON.stringify(evidence.answer ?? null),
              usageJson: JSON.stringify(evidence.usage ?? null),
              latencyMs: evidence.latencyMs ?? 0,
            },
          });
        },
      );
    }
    // Direction warnings are advice for the operator; they are returned, never stored.
    const warnings: string[] = isSceneSpecStoryboard(stored)
      ? [
          ...sceneSpecWarnings({
            scenes: stored.scenes,
            language: script.language,
            sceneTexts: stored.scenes.map((scene) =>
              script.body.slice(scene.fromChar, scene.toChar),
            ),
          }),
        ]
      : [];
    // v2 slice 32: dialogue frequency and voice separation advice (never blocking).
    if (isSceneSpecStoryboard(stored) && stored.scenes.some((scene) => scene.dialogue?.length)) {
      const voiceOf = (key: string) => {
        if (key === "narrator") return stored.voiceId;
        const character = explainer?.characters.find((entry) => entry.key === key);
        return characterVoiceId(character, stored.voiceId);
      };
      const words = stored.scenes.reduce(
        (sum, scene) => sum + sceneWordCount(script.body.slice(scene.fromChar, scene.toChar)),
        0,
      );
      warnings.push(
        ...(dialogueWarnings(
          stored.scenes,
          words * narrationMsPerWord(script.language),
        ) as never[]),
        ...voiceSeparationWarnings(stored.scenes, voiceOf),
      );
    }
    return {
      ok: true,
      value: {
        storyboardId: stored.id,
        version: stored.version,
        checksum: stored.checksum,
        totalScenes: stored.scenes.length,
        renderer: stored.renderer,
        ...(isSceneSpecRenderer(stored.renderer)
          ? {
              backgrounds: (stored.scenes as readonly SceneSpec[]).map((scene) => ({
                index: scene.index,
                backgroundAssetId: scene.backgroundAssetId ?? null,
              })),
            }
          : {}),
        warnings,
        // Additive (v2 slice 28): deterministic scene-graph QA, advice only (never stored).
        ...(isSceneSpecStoryboard(stored)
          ? {
              visualAdvice: sceneSpecFindings({
                scenes: stored.scenes,
                characterKeys: (explainer?.characters ?? []).map((character) => character.key),
                canvas: stored.canvas,
              }),
            }
          : {}),
        // Additive (v2 slice 16): one fix sentence per motion-budget warning, same order.
        warningHints: warnings.flatMap((warning) => {
          const hint = motionBudgetHint(warning);
          return hint ? [{ warning, hint }] : [];
        }),
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "script_not_approved")
      return { ok: false, error: "SCRIPT_NOT_APPROVED" };
    if (error instanceof Error && error.message.startsWith("storyboard_asset_invalid:"))
      return {
        ok: false,
        error: `STORYBOARD_ASSET_INVALID:${error.message.split(":").at(-1) ?? "unknown"}`,
      };
    if (error instanceof Error && error.message.startsWith("storyboard_scene_invalid:"))
      return {
        ok: false,
        error: `STORYBOARD_SCENE_INVALID:${error.message.slice("storyboard_scene_invalid:".length)}`,
      };
    if (error instanceof Error && error.message === "storyboard_coverage_invalid")
      return { ok: false, error: "STORYBOARD_COVERAGE_INVALID" };
    if (error instanceof Error && error.message === "STORYBOARD_VERSION_CONFLICT")
      return { ok: false, error: "STORYBOARD_VERSION_CONFLICT" };
    return { ok: false, error: "INVALID_ARGUMENTS" };
  }
};
