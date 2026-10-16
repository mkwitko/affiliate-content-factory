import { createHash, randomUUID } from "node:crypto";
import type { UserId, WorkspaceId } from "@money-maker/contracts";
import { LONG_FORM_MAX_SCENES } from "@money-maker/contracts/scene-spec-schema";
import type { Asset } from "../assets/asset.js";
import { isUsableBackground } from "../explainer/background-art.js";
import type { ExplainerCharacter } from "../explainer/explainer-context.js";
import { type SceneSpec, validateSceneSpecs } from "../explainer/scene-spec.js";
import type { ContentScript } from "./editorial.js";

export type StoryboardScene = Readonly<{
  index: number;
  fromChar: number;
  toChar: number;
  assetId: string;
  motion: "static" | "ken_burns_in" | "ken_burns_out" | "pan_left" | "pan_right";
  captionMode: "word" | "line" | "none";
}>;
/**
 * ai_clips: one generated video clip per scene (spec 2026-09-30 generative scene clips). The
 * prompt and optional reference are immutable and checksummed; generation progress lives in the
 * storyboard's clip state, never here.
 */
export type ClipScene = Readonly<{
  index: number;
  fromChar: number;
  toChar: number;
  /** Visual description only; the prompt compiler adds style and the locked negative block. */
  clipPrompt: string;
  /** A scene plate or character sheet we own, used as the image-to-video reference. */
  referenceAssetId?: string | undefined;
  captionMode: "word" | "line" | "none";
}>;
export const CLIP_PROMPT_MAX = 400;
const CLIP_REFERENCE_ROLES: readonly unknown[] = ["scene", "explainer_background", "character"];
/**
 * INV-G1: an image-to-video reference is a scene plate or character sheet we own (generated, or an
 * operator upload declared owned). Product, listing and canonical offer images are refused.
 */
export const isOwnedClipReference = (
  asset: Readonly<Asset> | null | undefined,
  workspaceId: string,
): boolean =>
  !!asset &&
  asset.workspaceId === workspaceId &&
  asset.state === "active" &&
  asset.mimeType.startsWith("image/") &&
  CLIP_REFERENCE_ROLES.includes(asset.metadata?.["role"]) &&
  (asset.provenance === "generated" ||
    (asset.provenance === "operator_upload" && /^owned$/i.test(asset.license.trim())));
const CLIP_MAX_SCENES = 12;
/**
 * slideshow: one image asset per scene. stickman_still: SceneSpec scenes composed as stills.
 * stickman_motion: the same SceneSpec scenes animated frame by frame, including actor actions.
 * ai_clips: ClipScene scenes, each a generated video clip.
 */
export type StoryboardRenderer = "slideshow" | "stickman_still" | "stickman_motion" | "ai_clips";
export const isSceneSpecRenderer = (
  renderer: StoryboardRenderer,
): renderer is "stickman_still" | "stickman_motion" =>
  renderer === "stickman_still" || renderer === "stickman_motion";
export const isSceneSpec = (scene: StoryboardScene | SceneSpec | ClipScene): scene is SceneSpec =>
  "purpose" in scene;
export const isClipScene = (scene: StoryboardScene | SceneSpec | ClipScene): scene is ClipScene =>
  "clipPrompt" in scene;
const STICKMAN_MIN_SCENES = 3;
const STICKMAN_MAX_SCENES = 12;

export type Storyboard = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  contentItemId: string;
  scriptId: string;
  version: number;
  renderer: StoryboardRenderer;
  scenes: readonly StoryboardScene[] | readonly SceneSpec[] | readonly ClipScene[];
  voiceId: string;
  musicTrackId: string | null;
  canvas: "landscape" | "portrait";
  checksum: string;
  createdAt: Date;
  actorId: UserId;
}>;

export const createStoryboard = (input: {
  id?: string;
  workspaceId: WorkspaceId;
  script: ContentScript;
  version: number;
  renderer?: StoryboardRenderer | undefined;
  scenes: readonly StoryboardScene[] | readonly SceneSpec[] | readonly ClipScene[];
  assets: readonly Asset[];
  /** Media niche cast; required for SceneSpec scenes that show actors. */
  characters?: readonly ExplainerCharacter[] | undefined;
  voiceId: string;
  musicTrackId?: string | null;
  canvas: "landscape" | "portrait";
  actorId: UserId;
  createdAt?: Date;
  /** Long-form niche format: SceneSpec boards may hold up to LONG_FORM_MAX_SCENES scenes. */
  longForm?: boolean | undefined;
}): Storyboard => {
  const sceneSpecCap = input.longForm ? LONG_FORM_MAX_SCENES : STICKMAN_MAX_SCENES;
  if (input.script.workspaceId !== input.workspaceId || input.script.status !== "approved")
    throw new Error("script_not_approved");
  if (
    !Number.isInteger(input.version) ||
    input.version < 1 ||
    !input.voiceId.trim() ||
    input.scenes.length < 1 ||
    input.scenes.length > (input.longForm ? LONG_FORM_MAX_SCENES : 40)
  )
    throw new Error("storyboard_invalid");
  const renderer = input.renderer ?? "slideshow";
  const scenesIn: readonly (StoryboardScene | SceneSpec | ClipScene)[] = input.scenes;
  const specs = scenesIn.filter(isSceneSpec);
  const clips = scenesIn.filter(isClipScene);
  if (renderer === "slideshow" && (specs.length > 0 || clips.length > 0))
    throw new Error("storyboard_invalid");
  if (
    renderer === "ai_clips" &&
    (input.canvas !== "portrait" ||
      clips.length !== scenesIn.length ||
      clips.length > CLIP_MAX_SCENES)
  )
    throw new Error("storyboard_invalid");
  if (isSceneSpecRenderer(renderer) && clips.length > 0) throw new Error("storyboard_invalid");
  if (
    isSceneSpecRenderer(renderer) &&
    // SceneSpec scenes are composed for a canvas geometry: portrait (1080x1920) for both
    // stickman renderers, landscape (1920x1080) for stickman_motion only.
    (!(
      input.canvas === "portrait" ||
      (input.canvas === "landscape" && renderer === "stickman_motion")
    ) ||
      specs.length !== scenesIn.length ||
      specs.length < STICKMAN_MIN_SCENES ||
      specs.length > sceneSpecCap)
  )
    throw new Error("storyboard_invalid");
  const assets = new Map(input.assets.map((asset) => [asset.id, asset]));
  let cursor = 0;
  for (const [index, scene] of scenesIn.entries()) {
    if (
      scene.index !== index + 1 ||
      scene.fromChar !== cursor ||
      scene.toChar <= scene.fromChar ||
      scene.toChar > input.script.body.length
    )
      throw new Error("storyboard_coverage_invalid");
    if (isClipScene(scene)) {
      const prompt = scene.clipPrompt.trim();
      if (prompt.length === 0 || prompt.length > CLIP_PROMPT_MAX)
        throw new Error(`storyboard_scene_invalid:${index + 1}:clip_prompt_invalid`);
      if (scene.referenceAssetId !== undefined) {
        if (!isOwnedClipReference(assets.get(scene.referenceAssetId), input.workspaceId))
          throw new Error(`storyboard_asset_invalid:${index + 1}`);
      }
    } else if (!isSceneSpec(scene)) {
      const asset = assets.get(scene.assetId);
      if (
        !asset ||
        asset.workspaceId !== input.workspaceId ||
        asset.state !== "active" ||
        !asset.mimeType.startsWith("image/")
      )
        throw new Error(`storyboard_asset_invalid:${index + 1}`);
    }
    if (
      isSceneSpec(scene) &&
      scene.backgroundAssetId !== undefined &&
      !isUsableBackground(assets.get(scene.backgroundAssetId), input.workspaceId)
    )
      throw new Error(`storyboard_asset_invalid:${index + 1}`);
    cursor = scene.toChar;
  }
  if (cursor !== input.script.body.length) throw new Error("storyboard_coverage_invalid");
  if (isSceneSpecRenderer(renderer)) {
    const verdict = validateSceneSpecs({
      scenes: specs,
      characters: input.characters ?? [],
      claims: input.script.claims,
      renderer,
      language: input.script.language,
      sceneTexts: specs.map((scene) => input.script.body.slice(scene.fromChar, scene.toChar)),
    });
    if (!verdict.ok)
      throw new Error(
        `storyboard_scene_invalid:${verdict.rejection.index}:${verdict.rejection.reason}`,
      );
  }
  const scenes = Object.freeze(scenesIn.map((scene) => Object.freeze({ ...scene }))) as
    | readonly StoryboardScene[]
    | readonly SceneSpec[]
    | readonly ClipScene[];
  // Slideshow checksums keep their original shape so existing storyboards stay comparable.
  const canonical = JSON.stringify({
    ...(renderer === "slideshow" ? {} : { renderer }),
    scriptChecksum: input.script.checksum,
    scenes,
    voiceId: input.voiceId,
    musicTrackId: input.musicTrackId ?? null,
    canvas: input.canvas,
  });
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    contentItemId: input.script.contentItemId,
    scriptId: input.script.id,
    version: input.version,
    renderer,
    scenes,
    voiceId: input.voiceId.trim(),
    musicTrackId: input.musicTrackId ?? null,
    canvas: input.canvas,
    checksum: createHash("sha256").update(canonical, "utf8").digest("hex"),
    createdAt: input.createdAt ?? new Date(),
    actorId: input.actorId,
  });
};

export const isSceneSpecStoryboard = (
  board: Storyboard,
): board is Storyboard & {
  renderer: "stickman_still" | "stickman_motion";
  scenes: readonly SceneSpec[];
} => isSceneSpecRenderer(board.renderer);

export const isClipStoryboard = (
  board: Storyboard,
): board is Storyboard & { renderer: "ai_clips"; scenes: readonly ClipScene[] } =>
  board.renderer === "ai_clips";
