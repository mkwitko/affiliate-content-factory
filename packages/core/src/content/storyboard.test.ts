import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Asset } from "../assets/asset.js";
import type { SceneSpec } from "../explainer/scene-spec.js";
import type { ContentScript } from "./editorial.js";
import { createStoryboard, isClipStoryboard, isSceneSpecStoryboard } from "./storyboard.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const script: ContentScript = {
  id: "script",
  workspaceId,
  contentItemId: "item",
  version: 1,
  status: "approved",
  body: "Hello world",
  language: "en",
  claims: [],
  beats: [],
  checksum: "a".repeat(64),
  createdAt: new Date(),
  actorId,
  approvedBy: actorId,
  approvedAt: new Date(),
  approvedChecksum: "a".repeat(64),
};
const asset: Asset = {
  id: "scene",
  workspaceId,
  objectKey: "key",
  checksum: "b".repeat(64),
  mimeType: "image/png",
  width: 1280,
  height: 720,
  provenance: "generated",
  commercialUse: true,
  license: "licensed",
  state: "active",
};
const scene = {
  index: 1,
  fromChar: 0,
  toChar: 11,
  assetId: "scene",
  motion: "static" as const,
  captionMode: "line" as const,
};
const input = {
  workspaceId,
  script,
  version: 1,
  scenes: [scene],
  assets: [asset],
  voiceId: "pf_dora",
  canvas: "landscape" as const,
  actorId,
};

describe("createStoryboard", () => {
  it("binds contiguous scene ranges to the approved script and exact scene assets", () => {
    const storyboard = createStoryboard(input);
    expect(storyboard.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(storyboard.scenes[0])).toBe(true);
    expect(
      createStoryboard({ ...input, script: { ...script, checksum: "c".repeat(64) } }).checksum,
    ).not.toBe(storyboard.checksum);
  });
  it("rejects gaps and unapproved scripts", () => {
    expect(() => createStoryboard({ ...input, scenes: [{ ...scene, fromChar: 1 }] })).toThrow(
      "storyboard_coverage_invalid",
    );
    expect(() => createStoryboard({ ...input, script: { ...script, status: "draft" } })).toThrow(
      "script_not_approved",
    );
  });
});

describe("stickman_still storyboards", () => {
  const alex = {
    key: "alex",
    name: "Alex",
    role: "main" as const,
    rigId: "stick-v1" as const,
    rigVersion: 1 as const,
    palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
  };
  const spec = (
    index: number,
    fromChar: number,
    toChar: number,
    purpose: "hook" | "explanation" | "payoff",
    background: "plain" | "bank" = "plain",
  ) => ({
    index,
    fromChar,
    toChar,
    purpose,
    background,
    actors: [
      {
        characterKey: "alex",
        pose: "neutral" as const,
        expression: "neutral" as const,
        position: "center" as const,
      },
    ],
    props: [],
    overlays: [],
    camera: {
      shot: index % 2 === 0 ? ("wide" as const) : ("medium" as const),
      movement: "none" as const,
    },
    transition: "hard_cut" as const,
    captionMode: "word" as const,
  });
  const longScript = { ...script, body: "a".repeat(30) };
  const specs = [
    spec(1, 0, 10, "hook"),
    spec(2, 10, 20, "explanation", "bank"),
    spec(3, 20, 30, "payoff"),
  ];
  const stickman = {
    workspaceId,
    script: longScript,
    version: 1,
    renderer: "stickman_still" as const,
    scenes: specs,
    assets: [],
    characters: [alex],
    voiceId: "af_heart",
    canvas: "portrait" as const,
    actorId,
  };

  it("binds painted backgrounds to usable background assets of the workspace", () => {
    const painting: Asset = {
      ...asset,
      id: "bg-1",
      mimeType: "image/jpeg",
      width: 1024,
      height: 1024,
      metadata: { role: "explainer_background" },
    };
    const scenes = [
      { ...specs[0], backgroundAssetId: "bg-1" },
      ...specs.slice(1),
    ] as readonly SceneSpec[];
    const motion = { ...stickman, renderer: "stickman_motion" as const, scenes };
    expect(createStoryboard({ ...motion, assets: [painting] }).scenes[0]).toMatchObject({
      backgroundAssetId: "bg-1",
    });
    for (const assets of [
      [],
      [{ ...painting, commercialUse: null }],
      [{ ...painting, state: "archived" as const }],
      [{ ...painting, metadata: { role: "character" } }],
      [{ ...painting, mimeType: "image/webp" }],
      [{ ...painting, workspaceId: parseWorkspaceId("33333333-3333-4333-8333-333333333333") }],
    ])
      expect(() => createStoryboard({ ...motion, assets })).toThrow("storyboard_asset_invalid:1");
    expect(() => createStoryboard({ ...stickman, scenes, assets: [painting] })).toThrow(
      "storyboard_scene_invalid:1:background_asset_requires_motion",
    );
  });

  it("defaults renderer to slideshow", () => {
    const board = createStoryboard(input);
    expect(board.renderer).toBe("slideshow");
    expect(isSceneSpecStoryboard(board)).toBe(false);
  });

  it("accepts scene specs with a valid cast", () => {
    const board = createStoryboard(stickman);
    expect(board.renderer).toBe("stickman_still");
    expect(board.scenes).toHaveLength(3);
    expect(isSceneSpecStoryboard(board)).toBe(true);
  });

  it("binds the renderer into the checksum", () => {
    const slideshow = createStoryboard(input);
    expect(createStoryboard({ ...input, renderer: "slideshow" }).checksum).toBe(slideshow.checksum);
    expect(createStoryboard(stickman).checksum).not.toBe(slideshow.checksum);
  });

  it("accepts stickman_motion with the same scene rules and binds it into the checksum", () => {
    const motion = createStoryboard({ ...stickman, renderer: "stickman_motion" });
    expect(motion.renderer).toBe("stickman_motion");
    expect(isSceneSpecStoryboard(motion)).toBe(true);
    expect(motion.checksum).not.toBe(createStoryboard(stickman).checksum);
  });

  it("accepts the landscape canvas for stickman_motion only", () => {
    const landscape = createStoryboard({
      ...stickman,
      renderer: "stickman_motion",
      canvas: "landscape",
    });
    expect(landscape.canvas).toBe("landscape");
    expect(landscape.checksum).not.toBe(
      createStoryboard({ ...stickman, renderer: "stickman_motion" }).checksum,
    );
    expect(() => createStoryboard({ ...stickman, canvas: "landscape" })).toThrow(
      "storyboard_invalid",
    );
  });

  it("validates actions against the scene narration and rejects them on stills", () => {
    const worded = { ...script, body: "one two three four five six seven eight nine ten eleven" };
    const withJump = (atWord: number): readonly SceneSpec[] => [
      {
        ...spec(1, 0, 13, "hook"),
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "center",
            actions: [{ type: "jump", atWord }],
          },
        ],
      },
      spec(2, 13, 27, "explanation", "bank"),
      spec(3, 27, worded.body.length, "payoff"),
    ];
    const base = { ...stickman, script: worded, renderer: "stickman_motion" as const };
    // Scene 1 is "one two three": three words.
    expect(createStoryboard({ ...base, scenes: withJump(2) }).scenes).toHaveLength(3);
    expect(() => createStoryboard({ ...base, scenes: withJump(3) })).toThrow(
      "storyboard_scene_invalid:1:action_word_out_of_range",
    );
    expect(() =>
      createStoryboard({ ...base, renderer: "stickman_still", scenes: withJump(1) }),
    ).toThrow("storyboard_scene_invalid:1:actions_require_motion");
  });

  it("names the failing scene and reason", () => {
    const actors = [
      { characterKey: "sam", pose: "neutral", expression: "neutral", position: "left" },
    ] as const;
    expect(() =>
      createStoryboard({
        ...stickman,
        scenes: [specs[0], { ...spec(2, 10, 20, "explanation"), actors }, specs[2]] as never,
      }),
    ).toThrow("storyboard_scene_invalid:2:character_missing");
  });

  it("rejects image scenes under the stickman renderer and specs under slideshow", () => {
    expect(() =>
      createStoryboard({ ...stickman, script, scenes: [scene], assets: [asset] }),
    ).toThrow("storyboard_invalid");
    expect(() =>
      createStoryboard({ ...input, script: longScript, scenes: specs, assets: [] }),
    ).toThrow("storyboard_invalid");
  });

  it("renders stickman stills in portrait only", () => {
    expect(() => createStoryboard({ ...stickman, canvas: "landscape" })).toThrow(
      "storyboard_invalid",
    );
  });

  it("requires 3 to 12 scenes", () => {
    expect(() => createStoryboard({ ...stickman, scenes: [spec(1, 0, 30, "hook")] })).toThrow(
      "storyboard_invalid",
    );
  });

  it("still checks contiguous coverage", () => {
    expect(() =>
      createStoryboard({
        ...stickman,
        scenes: [specs[0], spec(2, 12, 20, "explanation", "bank"), specs[2]] as never,
      }),
    ).toThrow("storyboard_coverage_invalid");
  });

  it("uses the script's claim count when none is given", () => {
    const withPercent = {
      ...spec(1, 0, 10, "hook"),
      actors: [],
      diagram: { kind: "percent" as const, value: 40, label: "x", claimRef: 0 },
    };
    expect(() =>
      createStoryboard({
        ...stickman,
        scenes: [withPercent, specs[1], specs[2]] as never,
      }),
    ).toThrow("storyboard_scene_invalid:1:diagram_number_without_claim");
  });
});

describe("ai_clips storyboards", () => {
  const refAsset: Asset = {
    ...asset,
    id: "plate",
    mimeType: "image/png",
    metadata: { role: "scene" },
  };
  const clip = (over: Record<string, unknown> = {}) => ({
    index: 1,
    fromChar: 0,
    toChar: 11,
    clipPrompt: "A quiet kitchen at dawn, steam rising from a mug",
    captionMode: "word" as const,
    ...over,
  });
  const clipInput = {
    ...input,
    renderer: "ai_clips" as const,
    canvas: "portrait" as const,
    scenes: [clip()],
    assets: [refAsset],
  };
  it("accepts clip scenes on a portrait canvas and freezes them", () => {
    const board = createStoryboard(clipInput);
    expect(board.renderer).toBe("ai_clips");
    expect(isClipStoryboard(board)).toBe(true);
    expect(isSceneSpecStoryboard(board)).toBe(false);
    expect(Object.isFrozen(board.scenes[0])).toBe(true);
  });
  it("covers the prompt and the reference in the checksum", () => {
    const base = createStoryboard(clipInput).checksum;
    expect(
      createStoryboard({ ...clipInput, scenes: [clip({ clipPrompt: "A park" })] }).checksum,
    ).not.toBe(base);
    expect(
      createStoryboard({ ...clipInput, scenes: [clip({ referenceAssetId: "plate" })] }).checksum,
    ).not.toBe(base);
  });
  it("requires portrait, 1 to 12 clip scenes and no image scenes", () => {
    expect(() => createStoryboard({ ...clipInput, canvas: "landscape" })).toThrow(
      "storyboard_invalid",
    );
    expect(() => createStoryboard({ ...clipInput, scenes: [scene] })).toThrow("storyboard_invalid");
    const many = Array.from({ length: 13 }, (_, i) =>
      clip({ index: i + 1, fromChar: i, toChar: i + 1 }),
    );
    expect(() =>
      createStoryboard({
        ...clipInput,
        script: { ...script, body: "x".repeat(13) },
        scenes: many,
      }),
    ).toThrow("storyboard_invalid");
  });
  it("rejects a clip scene on a slideshow and an over-long or empty prompt", () => {
    expect(() =>
      createStoryboard({ ...clipInput, renderer: "slideshow", canvas: "landscape" }),
    ).toThrow("storyboard_invalid");
    expect(() =>
      createStoryboard({ ...clipInput, scenes: [clip({ clipPrompt: "x".repeat(401) })] }),
    ).toThrow("storyboard_scene_invalid:1:clip_prompt_invalid");
    expect(() => createStoryboard({ ...clipInput, scenes: [clip({ clipPrompt: " " })] })).toThrow(
      "storyboard_scene_invalid:1:clip_prompt_invalid",
    );
  });
  it("needs an active, same-workspace image for referenceAssetId", () => {
    const scenes = [clip({ referenceAssetId: "plate" })];
    expect(() => createStoryboard({ ...clipInput, scenes, assets: [] })).toThrow(
      "storyboard_asset_invalid:1",
    );
    expect(() =>
      createStoryboard({ ...clipInput, scenes, assets: [{ ...refAsset, state: "pending" }] }),
    ).toThrow("storyboard_asset_invalid:1");
    expect(() =>
      createStoryboard({ ...clipInput, scenes, assets: [{ ...refAsset, mimeType: "video/mp4" }] }),
    ).toThrow("storyboard_asset_invalid:1");
    expect(createStoryboard({ ...clipInput, scenes }).scenes).toHaveLength(1);
  });
  it("accepts only owned scene plates or character sheets as referenceAssetId", () => {
    const scenes = [clip({ referenceAssetId: "plate" })];
    const refused = (over: Partial<Asset>) =>
      expect(() =>
        createStoryboard({ ...clipInput, scenes, assets: [{ ...refAsset, ...over }] }),
      ).toThrow("storyboard_asset_invalid:1");
    refused({ metadata: { role: "canonical_product" } });
    refused({ metadata: { role: "listing_picture" } });
    refused({ metadata: {} });
    refused({ provenance: "stock" });
    refused({ provenance: "operator_upload", license: "licensed:someone" });
    expect(
      createStoryboard({
        ...clipInput,
        scenes,
        assets: [{ ...refAsset, metadata: { role: "character" } }],
      }).scenes,
    ).toHaveLength(1);
    expect(
      createStoryboard({
        ...clipInput,
        scenes,
        assets: [{ ...refAsset, provenance: "operator_upload", license: "owned" }],
      }).scenes,
    ).toHaveLength(1);
  });
});
