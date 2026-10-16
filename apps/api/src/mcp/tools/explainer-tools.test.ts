import { describe, expect, it, vi } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentItem } from "@money-maker/core/content/content";
import type { ContentScript } from "@money-maker/core/content/editorial";
import type { Storyboard } from "@money-maker/core/content/storyboard";
import type { Niche } from "@money-maker/core/niches/niche";
import type { McpDependencies } from "../server.js";
import { createContentItemTool } from "./create-content-item.js";
import {
  approveContentScriptTool,
  createContentScriptTool,
  getContentScriptTool,
} from "./content-scripts.js";
import type { Asset } from "@money-maker/core/assets/asset";
import { createStoryboard } from "@money-maker/core/content/storyboard";
import { createVideoStoryboardTool } from "./create-video-storyboard.js";
import { previewVideoStoryboardTool } from "./preview-video-storyboard.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const alex = {
  key: "alex",
  name: "Alex",
  role: "main",
  description: "Main explainer.",
  rigId: "stick-v1",
  rigVersion: 1,
  palette: { line: "#111111", fill: "#ffffff", accent: "#ff5a36" },
};
const nicheBase = {
  workspaceId,
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["en-US"],
  monetizationHypothesis: "m",
  state: "active" as const,
};
const mediaNiche: Niche = {
  ...nicheBase,
  id: "media",
  name: "HTWW",
  kind: "media",
  context: { characters: [alex] },
};
const affiliateNiche: Niche = { ...nicheBase, id: "casa", name: "Casa", kind: "affiliate" };
const item = (nicheId: string): ContentItem => ({
  id: `item-${nicheId}`,
  workspaceId,
  nicheId,
  offerId: null,
  offerSnapshotId: null,
  title: "Why milk is at the back",
  sourceFactKeys: [],
  creativeOpinion: "x",
  state: "draft",
});
const approvedScript = (nicheId: string, body = "a".repeat(30)): ContentScript => ({
  id: `script-${nicheId}`,
  workspaceId,
  contentItemId: `item-${nicheId}`,
  version: 1,
  status: "approved",
  body,
  language: "en-US",
  claims: [],
  beats: [],
  checksum: "a".repeat(64),
  createdAt: new Date(),
  actorId,
  approvedBy: actorId,
  approvedAt: new Date(),
  approvedChecksum: "a".repeat(64),
});

const fixture = (mediaContext: Niche["context"] = mediaNiche.context ?? null) => {
  const storyboards: Storyboard[] = [];
  const scripts: ContentScript[] = [];
  const niches = new Map(
    [{ ...mediaNiche, context: mediaContext }, affiliateNiche].map((niche) => [niche.id, niche]),
  );
  const deps: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "W" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
      addMembership: async () => undefined,
    },
    nicheRepository: {
      create: async (niche) => niche,
      findForWorkspace: async ({ nicheId }) => niches.get(nicheId) ?? null,
      updateState: async () => null,
    },
    contentRepository: {
      findContentItemForWorkspace: async ({ contentItemId }: { contentItemId: string }) =>
        contentItemId.startsWith("item-") ? item(contentItemId.slice("item-".length)) : null,
    } as unknown as NonNullable<McpDependencies["contentRepository"]>,
    offerRepository: {
      findForWorkspace: async () => ({ id: "offer-1", workspaceId, snapshots: [] }),
    } as unknown as NonNullable<McpDependencies["offerRepository"]>,
    researchRepository: {
      findObservationForWorkspace: async () => ({ expiresAt: new Date(Date.now() + 86_400_000) }),
    } as unknown as NonNullable<McpDependencies["researchRepository"]>,
    editorialRepository: {
      nextScriptVersion: async () => 1,
      createScript: async (script: ContentScript) => {
        scripts.push(script);
        return script;
      },
      findScriptForWorkspace: async ({ scriptId }: { scriptId: string }) =>
        scriptId.startsWith("script-") ? approvedScript(scriptId.slice("script-".length)) : null,
    } as unknown as NonNullable<McpDependencies["editorialRepository"]>,
    assetRepository: {
      findForWorkspace: async () => null,
    } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    storyboardRepository: {
      create: async (board) => {
        storyboards.push(board);
        return board;
      },
      findForWorkspace: async () => null,
      findLatestForScript: async () => null,
    },
  };
  return { deps, storyboards, scripts };
};

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const observation = {
  kind: "research_observation",
  observationId: "33333333-3333-4333-8333-333333333333",
};
const scriptInput = (nicheId: string, over: Record<string, unknown> = {}) => ({
  workspaceId,
  contentItemId: `item-${nicheId}`,
  body: `Your supermarket wants you lost. ${words(90)}`,
  language: "en-US",
  claims: [
    {
      text: "Dairy needs refrigeration at the back wall",
      kind: "verified_fact",
      evidence: [observation],
    },
  ],
  beats: [
    { kind: "hook", atChar: 0, label: "hidden_reason" },
    { kind: "payoff", atChar: 200 },
  ],
  ...over,
});

const spec = (
  index: number,
  fromChar: number,
  toChar: number,
  purpose: string,
  over: Record<string, unknown> = {},
) => ({
  index,
  fromChar,
  toChar,
  purpose,
  background: "store",
  actors: [{ characterKey: "alex", pose: "pointing", expression: "happy", position: "left" }],
  props: [],
  overlays: [],
  camera: { shot: "medium", movement: "none" },
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const storyboardInput = (over: Record<string, unknown> = {}) => ({
  workspaceId,
  scriptId: "script-media",
  renderer: "stickman_still",
  voiceId: "af_heart",
  canvas: "portrait",
  scenes: [
    spec(1, 0, 10, "hook"),
    spec(2, 10, 20, "explanation", {
      background: "bank",
      camera: { shot: "wide", movement: "none" },
    }),
    spec(3, 20, 30, "payoff", { props: [{ type: "milk_carton", position: "right" }] }),
  ],
  ...over,
});

/** Fixture deps whose approved media script has this body, for scenes with longer narration. */
const depsWithBody = (body: string): McpDependencies => {
  const { deps } = fixture();
  return {
    ...deps,
    editorialRepository: {
      ...(deps.editorialRepository as NonNullable<McpDependencies["editorialRepository"]>),
      findScriptForWorkspace: async () => approvedScript("media", body),
    },
  };
};

describe("create_content_item for media niches", () => {
  it("rejects an offer on a media niche", async () => {
    const { deps } = fixture();
    const result = await createContentItemTool(
      {
        workspaceId,
        nicheId: "media",
        offerId: "offer-1",
        title: "t",
        sourceFactKeys: ["price"],
        creativeOpinion: "x",
      },
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "NICHE_KIND_MISMATCH" });
  });
});

describe("create_content_script for media niches", () => {
  it("accepts a valid explainer and reports its length and hook type", async () => {
    const { deps, scripts } = fixture();
    const result = await createContentScriptTool(scriptInput("media"), actorId, deps);
    expect(result).toMatchObject({ ok: true, value: { hookType: "hidden_reason" } });
    expect(result.ok && typeof result.value.estimatedSeconds).toBe("number");
    expect(scripts[0]?.claims[0]?.kind).toBe("verified_fact");
  });

  it("rejects a factual explainer whose only claims are analogies", async () => {
    const { deps } = fixture();
    const result = await createContentScriptTool(
      scriptInput("media", { claims: [{ text: "like a maze", kind: "analogy", evidence: [] }] }),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "EXPLAINER_SCRIPT_REJECTED:no_verified_fact" });
  });

  it("rejects a template opener", async () => {
    const { deps } = fixture();
    const result = await createContentScriptTool(
      scriptInput("media", { body: `Did you know supermarkets ${words(90)}` }),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "EXPLAINER_SCRIPT_REJECTED:generic_opener" });
  });

  it("rejects a simplification without its note as invalid arguments", async () => {
    const { deps } = fixture();
    const result = await createContentScriptTool(
      scriptInput("media", {
        claims: [
          { text: "f", kind: "verified_fact", evidence: [observation] },
          { text: "banks lend deposits", kind: "reasonable_simplification", evidence: [] },
        ],
      }),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("leaves affiliate niches untouched by explainer guards", async () => {
    const { deps } = fixture();
    const result = await createContentScriptTool(
      scriptInput("casa", { body: "Did you know this is short", beats: [] }),
      actorId,
      deps,
    );
    expect(result.ok).toBe(true);
  });

  it("keeps affiliate claims evidence-backed: no typed or evidence-less claims", async () => {
    const { deps } = fixture();
    for (const claim of [
      { text: "custa só R$ 49", kind: "hypothesis", evidence: [] },
      { text: "like a maze", kind: "analogy", evidence: [] },
      { text: "untyped", evidence: [] },
    ]) {
      const result = await createContentScriptTool(
        scriptInput("casa", { body: "Short affiliate script", beats: [], claims: [claim] }),
        actorId,
        deps,
      );
      expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
    }
  });
});

describe("media script review and approval", () => {
  const typedClaims = [
    {
      text: "Dairy needs refrigeration at the back wall",
      kind: "verified_fact",
      evidence: [observation],
    },
    { text: "a store is a maze", kind: "analogy", evidence: [] },
    {
      text: "aisles steer you",
      kind: "reasonable_simplification",
      note: "ignores layout data",
      evidence: [],
    },
  ];
  const draftDeps = (observationFound: boolean) => {
    const { deps, scripts } = fixture();
    const editorial = deps.editorialRepository as NonNullable<
      McpDependencies["editorialRepository"]
    >;
    const approveDraft = vi.fn(async () => null);
    return {
      scripts,
      approveDraft,
      deps: {
        ...deps,
        researchRepository: {
          findObservationForWorkspace: async () =>
            observationFound
              ? {
                  expiresAt: new Date(Date.now() + 86_400_000),
                  sourceUrl: "https://example.org/a",
                  value: "v",
                }
              : null,
        } as unknown as NonNullable<McpDependencies["researchRepository"]>,
        editorialRepository: {
          ...editorial,
          approveDraft,
          findScriptForWorkspace: async () => scripts[0] ?? null,
        } as unknown as NonNullable<McpDependencies["editorialRepository"]>,
      },
    };
  };

  it("stores a new media script as a draft and shows each claim's kind and note for review", async () => {
    const { deps, scripts } = draftDeps(true);
    const created = await createContentScriptTool(
      scriptInput("media", { claims: typedClaims }),
      actorId,
      deps,
    );
    expect(created.ok).toBe(true);
    expect(scripts[0]?.status).toBe("draft");
    const read = await getContentScriptTool(
      { workspaceId, scriptId: scripts[0]?.id },
      actorId,
      deps,
    );
    expect(read.ok && (read.value as { script: { claims: unknown } }).script.claims).toEqual([
      expect.objectContaining({
        kind: "verified_fact",
        evidence: [expect.objectContaining({ sourceUrl: "https://example.org/a" })],
      }),
      { text: "a store is a maze", kind: "analogy", evidence: [] },
      {
        text: "aisles steer you",
        kind: "reasonable_simplification",
        note: "ignores layout data",
        evidence: [],
      },
    ]);
  });

  it("refuses approval when a cited observation no longer resolves", async () => {
    const { deps: createDeps, scripts } = draftDeps(true);
    await createContentScriptTool(scriptInput("media"), actorId, createDeps);
    const { deps, approveDraft } = draftDeps(false);
    const result = await approveContentScriptTool(
      { workspaceId, scriptId: scripts[0]?.id, checksum: scripts[0]?.checksum },
      actorId,
      {
        ...deps,
        editorialRepository: {
          ...(deps.editorialRepository as object),
          findScriptForWorkspace: async () => scripts[0] ?? null,
        } as unknown as NonNullable<McpDependencies["editorialRepository"]>,
      },
    );
    expect(result).toEqual({ ok: false, error: "CLAIM_UNRESOLVED:0" });
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it("rejects an unknown hook type and a script longer than the niche target", async () => {
    const { deps } = fixture();
    expect(
      await createContentScriptTool(
        scriptInput("media", {
          beats: [
            { kind: "hook", atChar: 0, label: "clickbait" },
            { kind: "payoff", atChar: 200 },
          ],
        }),
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "EXPLAINER_SCRIPT_REJECTED:hook_type_missing" });
    expect(
      await createContentScriptTool(
        scriptInput("media", { body: `Your supermarket wants you lost. ${words(400)}` }),
        actorId,
        deps,
      ),
    ).toEqual({ ok: false, error: "EXPLAINER_SCRIPT_REJECTED:too_long" });
  });
});

describe("create_video_storyboard with SceneSpec scenes", () => {
  const painting = (id: string, setting: string, usageCount: number): Asset => ({
    id,
    workspaceId,
    objectKey: id,
    checksum: id,
    mimeType: "image/png",
    width: 1024,
    height: 1024,
    provenance: "generated",
    commercialUse: true,
    license: "Apache-2.0 (local:z-image-turbo, local)",
    creator: "local:z-image-turbo",
    state: "active",
    metadata: {
      role: "explainer_background",
      sceneKey: `media:explainer:${setting}:sketch_watercolor:v1`,
      usageCount,
    },
  });
  const bankFixture = (bank: readonly Asset[]) => {
    const { deps: base, storyboards } = fixture({
      characters: [alex],
      explainer: { style: "sketch_watercolor" },
    });
    const bumped: string[] = [];
    const deps: McpDependencies = {
      ...base,
      assetRepository: {
        findForWorkspace: async ({ assetId }: { assetId: string }) =>
          bank.find((asset) => asset.id === assetId) ?? null,
        listByMetadata: async ({ value }: { value: string }) =>
          bank.filter((asset) => asset.metadata?.sceneKey === value),
        updateMetadata: async ({ assetId }: { assetId: string }) => {
          bumped.push(assetId);
          return null;
        },
      } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    };
    return { deps, storyboards, bumped };
  };

  it("fills painted backgrounds from the niche bank and keeps an explicit one", async () => {
    const { deps, storyboards, bumped } = bankFixture([
      painting("store-a", "store", 3),
      painting("store-b", "store", 1),
      painting("bank-a", "bank", 0),
      painting("own", "kitchen", 9),
    ]);
    const input = storyboardInput({ renderer: "stickman_motion" });
    const scenes = [
      input.scenes[0],
      input.scenes[1],
      { ...(input.scenes[2] as object), backgroundAssetId: "own" },
    ];
    const result = await createVideoStoryboardTool({ ...input, scenes }, actorId, deps);
    expect(result).toMatchObject({
      ok: true,
      value: {
        backgrounds: [
          { index: 1, backgroundAssetId: "store-b" },
          { index: 2, backgroundAssetId: "bank-a" },
          { index: 3, backgroundAssetId: "own" },
        ],
      },
    });
    expect(bumped).toEqual(["store-b", "bank-a"]);
    expect(storyboards[0]?.scenes[0]).toMatchObject({ backgroundAssetId: "store-b" });
  });

  it("keeps the procedural setting when the bank has no usable painting for it", async () => {
    const { deps } = bankFixture([{ ...painting("store-x", "store", 0), commercialUse: null }]);
    const result = await createVideoStoryboardTool(
      storyboardInput({ renderer: "stickman_motion" }),
      actorId,
      deps,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        backgrounds: [{ index: 1, backgroundAssetId: null }, expect.anything(), expect.anything()],
      },
    });
  });

  it("rejects painted backgrounds on stills, unknown ids and assets that are not backgrounds", async () => {
    const { deps } = bankFixture([
      painting("own", "kitchen", 0),
      { ...painting("sheet", "kitchen", 0), metadata: { role: "character" } },
    ]);
    const withBackground = (renderer: string, backgroundAssetId: string) => {
      const input = storyboardInput({ renderer });
      return {
        ...input,
        scenes: [{ ...(input.scenes[0] as object), backgroundAssetId }, ...input.scenes.slice(1)],
      };
    };
    expect(
      await createVideoStoryboardTool(withBackground("stickman_still", "own"), actorId, deps),
    ).toEqual({
      ok: false,
      error: "STORYBOARD_SCENE_INVALID:1:background_asset_requires_motion",
    });
    expect(
      await createVideoStoryboardTool(withBackground("stickman_motion", "missing"), actorId, deps),
    ).toEqual({
      ok: false,
      error: "STORYBOARD_ASSET_INVALID:unknown",
    });
    expect(
      await createVideoStoryboardTool(withBackground("stickman_motion", "sheet"), actorId, deps),
    ).toEqual({
      ok: false,
      error: "STORYBOARD_ASSET_INVALID:1",
    });
  });

  it("refuses a scene naming a location the niche does not have (v2 slice 23)", async () => {
    const first = words(8);
    const body = `${first} ${"b".repeat(10)} ${"c".repeat(10)}`;
    const input = storyboardInput({ renderer: "stickman_motion" });
    const result = await createVideoStoryboardTool(
      {
        ...input,
        scenes: [
          spec(1, 0, first.length, "hook", { locationId: "office_a", zoneId: "desk" }),
          spec(2, first.length, first.length + 11, "explanation", {
            background: "bank",
            camera: { shot: "wide", movement: "none" },
          }),
          spec(3, first.length + 11, body.length, "payoff", {
            props: [{ type: "milk_carton", position: "right" }],
          }),
        ],
      },
      actorId,
      depsWithBody(body),
    );
    expect(result).toEqual({
      ok: false,
      error: "STORYBOARD_SCENE_INVALID:1:location_unknown",
    });
  });

  it("accepts an emote and rejects overlaps, unknown emotions and emotes under 900 ms", async () => {
    // Scene 1 narrates 8 words (~2.9 s at 165 wpm): room for an 1800 ms emote from word 1.
    const first = words(8);
    const body = `${first} ${"b".repeat(10)} ${"c".repeat(10)}`;
    const input = storyboardInput({ renderer: "stickman_motion" });
    const run = (actions: readonly Record<string, unknown>[]) =>
      createVideoStoryboardTool(
        {
          ...input,
          scenes: [
            spec(1, 0, first.length, "hook", {
              actors: [
                {
                  characterKey: "alex",
                  pose: "neutral",
                  expression: "neutral",
                  position: "center",
                  actions,
                },
              ],
            }),
            spec(2, first.length, first.length + 11, "explanation", {
              background: "bank",
              camera: { shot: "wide", movement: "none" },
            }),
            spec(3, first.length + 11, body.length, "payoff", {
              props: [{ type: "milk_carton", position: "right" }],
            }),
          ],
        },
        actorId,
        depsWithBody(body),
      );
    const emote = { type: "emote", atWord: 1, emotion: "searching" };
    // v2 slice 16: a primary action on the word after the cut is advice, never a rejection.
    await expect(run([emote])).resolves.toMatchObject({
      ok: true,
      value: {
        renderer: "stickman_motion",
        warnings: ["cut_hold:1"],
        warningHints: [{ warning: "cut_hold:1", hint: expect.stringContaining("anchor it") }],
        // v2 slice 28: additive scene-graph advice; a clean storyboard has none.
        visualAdvice: [],
      },
    });
    await expect(run([{ ...emote, priority: "secondary" }])).resolves.toMatchObject({
      ok: true,
      value: { warnings: [] },
    });
    await expect(
      run([emote, { type: "expression", atWord: 2, expression: "happy" }]),
    ).resolves.toEqual({ ok: false, error: "STORYBOARD_SCENE_INVALID:1:action_overlap" });
    for (const bad of [
      { ...emote, emotion: "bored" },
      { ...emote, durationMs: 800 },
    ])
      await expect(run([bad])).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("warns about a long scene with no cut or action, without blocking the storyboard", async () => {
    // Scene 2 narrates 20 words: ~7.3 s at 165 wpm.
    const body = `${"a".repeat(10)} ${words(20)} ${"b".repeat(10)}`;
    const end = body.length - 10;
    const scenesWith = (actions: readonly Record<string, unknown>[]) => [
      spec(1, 0, 10, "hook"),
      spec(2, 10, end, "explanation", {
        background: "bank",
        camera: { shot: "wide", movement: "none" },
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "left",
            actions,
          },
        ],
      }),
      spec(3, end, body.length, "payoff", { props: [{ type: "milk_carton", position: "right" }] }),
    ];
    const input = storyboardInput({ renderer: "stickman_motion" });
    await expect(
      createVideoStoryboardTool({ ...input, scenes: scenesWith([]) }, actorId, depsWithBody(body)),
    ).resolves.toMatchObject({ ok: true, value: { warnings: ["static_stretch:2"] } });
    await expect(
      createVideoStoryboardTool(
        { ...input, scenes: scenesWith([{ type: "jump", atWord: 10 }]) },
        actorId,
        depsWithBody(body),
      ),
    ).resolves.toMatchObject({ ok: true, value: { warnings: [] } });
  });

  it("accepts the motivated camera moves and rejects unknown ones", async () => {
    const input = storyboardInput({ renderer: "stickman_motion" });
    const withCamera = (movement: string) => [
      { ...(input.scenes[0] as object), camera: { shot: "medium", movement } },
      ...input.scenes.slice(1),
    ];
    for (const movement of ["push_in", "low_angle", "handheld"])
      await expect(
        createVideoStoryboardTool(
          { ...input, scenes: withCamera(movement) },
          actorId,
          fixture().deps,
        ),
      ).resolves.toMatchObject({ ok: true, value: { renderer: "stickman_motion" } });
    await expect(
      createVideoStoryboardTool(
        { ...input, scenes: withCamera("dolly_zoom") },
        actorId,
        fixture().deps,
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("creates a stickman_still storyboard", async () => {
    const { deps, storyboards } = fixture();
    const result = await createVideoStoryboardTool(storyboardInput(), actorId, deps);
    expect(result).toMatchObject({
      ok: true,
      value: { totalScenes: 3, renderer: "stickman_still" },
    });
    expect(storyboards[0]?.renderer).toBe("stickman_still");
  });

  it("records a Jev shadow route without changing the accepted storyboard", async () => {
    const { deps, storyboards } = fixture();
    const record = vi.fn(async () => "audit-1");
    const decide = vi.fn(async () => ({
      requestedModel: "jev-latest",
      resolvedModel: "jev-1.13.0",
      answer: {
        type: "choice" as const,
        choice: "LOCAL_I2V",
        probabilities: { LOCAL_I2V: 1 },
        confidence: 1,
      },
      usage: { input_tokens: 10, output_tokens: 4 },
      latencyMs: 5,
    }));
    const result = await createVideoStoryboardTool(storyboardInput(), actorId, {
      ...deps,
      audit: { record },
      decisionProvider: { decide },
    });
    expect(result).toMatchObject({ ok: true, value: { renderer: "stickman_still" } });
    expect(storyboards[0]?.renderer).toBe("stickman_still");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ name: "generation_route" }));
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.decision.shadow_recorded",
        targetId: storyboards[0]?.id,
        metadata: expect.objectContaining({ finalAcceptedRoute: "STICKMAN" }),
      }),
    );
    decide.mockRejectedValueOnce(new Error("provider unavailable"));
    expect(
      await createVideoStoryboardTool(storyboardInput(), actorId, {
        ...deps,
        audit: { record },
        decisionProvider: { decide },
      }),
    ).toMatchObject({ ok: true });
  });

  it("narrates with the main character's voice when no voice is given", async () => {
    const { deps, storyboards } = fixture({
      voiceId: "af_heart",
      characters: [{ ...alex, voiceId: "am_adam" }],
    });
    const { voiceId: _omitted, ...input } = storyboardInput();
    const result = await createVideoStoryboardTool(input, actorId, deps);
    expect(result).toMatchObject({ ok: true });
    expect(storyboards[0]?.voiceId).toBe("am_adam");
  });

  it("falls back to the niche voice, and asks for one when nothing is configured", async () => {
    const { voiceId: _omitted, ...input } = storyboardInput();
    const withNiche = fixture({ voiceId: "af_heart", characters: [alex] });
    await createVideoStoryboardTool(input, actorId, withNiche.deps);
    expect(withNiche.storyboards[0]?.voiceId).toBe("af_heart");
    const bare = fixture({ characters: [alex] });
    await expect(createVideoStoryboardTool(input, actorId, bare.deps)).resolves.toEqual({
      ok: false,
      error: "STORYBOARD_VOICE_INVALID:voice_required",
    });
  });

  it("rejects a narration voice in another language than the script", async () => {
    const { deps } = fixture();
    await expect(
      createVideoStoryboardTool(storyboardInput({ voiceId: "pf_dora" }), actorId, deps),
    ).resolves.toEqual({ ok: false, error: "STORYBOARD_VOICE_INVALID:voice_language_mismatch" });
  });

  it("still requires a voice on slideshow storyboards", async () => {
    const { deps } = fixture();
    const result = await createVideoStoryboardTool(
      {
        workspaceId,
        scriptId: "script-media",
        canvas: "portrait",
        scenes: [
          {
            index: 1,
            fromChar: 0,
            toChar: 30,
            assetId: "a1",
            motion: "static",
            captionMode: "word",
          },
        ],
      },
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("creates a stickman_motion storyboard whose actors act on narration words", async () => {
    const { deps, storyboards } = fixture();
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral",
        expression: "neutral",
        position: "center",
        actions: [
          // The fixture scene narrates one word (~364 ms), so the entrance is quick.
          { type: "enter", atWord: 0, from: "left", durationMs: 850 },
          { type: "expression", atWord: 0, expression: "surprised" },
        ],
      },
    ];
    const input = storyboardInput({ renderer: "stickman_motion" });
    const scenes = [{ ...(input.scenes[0] as object), actors }, ...input.scenes.slice(1)];
    const result = await createVideoStoryboardTool({ ...input, scenes }, actorId, deps);
    expect(result).toMatchObject({ ok: true, value: { renderer: "stickman_motion" } });
    expect(storyboards[0]?.renderer).toBe("stickman_motion");
  });

  it("accepts point_at at a prop of the scene and names a missing target", async () => {
    const input = storyboardInput({ renderer: "stickman_motion" });
    const withPoint = (index: number) => [
      {
        ...(input.scenes[0] as object),
        props: [{ type: "milk_carton", position: "right" }],
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "left",
            actions: [
              { type: "point_at", atWord: 0, target: { kind: "prop", index }, durationMs: 400 },
            ],
          },
        ],
      },
      ...input.scenes.slice(1),
    ];
    await expect(
      createVideoStoryboardTool({ ...input, scenes: withPoint(0) }, actorId, fixture().deps),
    ).resolves.toMatchObject({ ok: true, value: { renderer: "stickman_motion" } });
    await expect(
      createVideoStoryboardTool({ ...input, scenes: withPoint(1) }, actorId, fixture().deps),
    ).resolves.toEqual({ ok: false, error: "STORYBOARD_SCENE_INVALID:1:action_target_missing" });
  });

  it("accepts look_at at another actor and rejects itself and malformed keys", async () => {
    const bia = { ...alex, key: "bia", name: "Bia", role: "secondary", description: "Friend." };
    const input = storyboardInput({ renderer: "stickman_motion" });
    const withLook = (characterKey: string) => [
      {
        ...(input.scenes[0] as object),
        actors: [
          {
            characterKey: "alex",
            pose: "neutral",
            expression: "neutral",
            position: "left",
            actions: [
              {
                type: "look_at",
                atWord: 0,
                target: { kind: "actor", characterKey },
                durationMs: 400,
              },
            ],
          },
          { characterKey: "bia", pose: "neutral", expression: "neutral", position: "right" },
        ],
      },
      ...input.scenes.slice(1),
    ];
    const cast = () => fixture({ characters: [alex, bia] }).deps;
    await expect(
      createVideoStoryboardTool({ ...input, scenes: withLook("bia") }, actorId, cast()),
    ).resolves.toMatchObject({ ok: true, value: { renderer: "stickman_motion" } });
    await expect(
      createVideoStoryboardTool({ ...input, scenes: withLook("alex") }, actorId, cast()),
    ).resolves.toEqual({ ok: false, error: "STORYBOARD_SCENE_INVALID:1:action_target_missing" });
    await expect(
      createVideoStoryboardTool({ ...input, scenes: withLook("Not A Key") }, actorId, cast()),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects an unknown action at the boundary", async () => {
    const { deps } = fixture();
    const input = storyboardInput({ renderer: "stickman_motion" });
    const actors = [
      {
        characterKey: "alex",
        pose: "neutral",
        expression: "neutral",
        position: "center",
        actions: [{ type: "moonwalk", atWord: 0 }],
      },
    ];
    const scenes = [{ ...(input.scenes[0] as object), actors }, ...input.scenes.slice(1)];
    await expect(createVideoStoryboardTool({ ...input, scenes }, actorId, deps)).resolves.toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });

  it("rejects stickman_still on an affiliate niche", async () => {
    const { deps } = fixture();
    const result = await createVideoStoryboardTool(
      storyboardInput({ scriptId: "script-casa" }),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "NICHE_KIND_MISMATCH" });
  });

  it("names the failing scene", async () => {
    const { deps } = fixture();
    const input = storyboardInput();
    const scenes = [...input.scenes];
    scenes[1] = spec(2, 10, 20, "explanation", {
      background: "bank",
      actors: [{ characterKey: "sam", pose: "neutral", expression: "neutral", position: "left" }],
    });
    const result = await createVideoStoryboardTool({ ...input, scenes }, actorId, deps);
    expect(result).toEqual({ ok: false, error: "STORYBOARD_SCENE_INVALID:2:character_missing" });
  });

  it("rejects SceneSpec scenes under the slideshow renderer as invalid arguments", async () => {
    const { deps } = fixture();
    const result = await createVideoStoryboardTool(
      storyboardInput({ renderer: "slideshow" }),
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects an unknown pose at the boundary", async () => {
    const { deps } = fixture();
    const input = storyboardInput();
    const scenes = [...input.scenes];
    scenes[0] = spec(1, 0, 10, "hook", {
      actors: [{ characterKey: "alex", pose: "moonwalk", expression: "happy", position: "left" }],
    });
    const result = await createVideoStoryboardTool({ ...input, scenes }, actorId, deps);
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});

describe("preview_video_storyboard", () => {
  const board = (renderer: "stickman_still" | "slideshow") =>
    renderer === "stickman_still"
      ? createStoryboard({
          id: "board-stick",
          workspaceId,
          script: approvedScript("media"),
          version: 1,
          renderer,
          scenes: storyboardInput().scenes as never,
          assets: [],
          characters: [alex as never],
          voiceId: "af_heart",
          canvas: "portrait",
          actorId,
        })
      : ({
          id: "board-slides",
          renderer,
          scenes: [],
          scriptId: "script-media",
        } as unknown as Storyboard);
  const previewFixture = (
    renderer: "stickman_still" | "slideshow" = "stickman_still",
    canvas: "portrait" | "landscape" = "portrait",
  ) => {
    const base = fixture();
    const assets: Asset[] = [];
    const stored: string[] = [];
    let rasterized = 0;
    const sizes: { width: number; height: number }[] = [];
    const deps: McpDependencies = {
      ...base.deps,
      publicApiUrl: "https://api.example.com",
      storyboardRepository: {
        ...(base.deps.storyboardRepository as NonNullable<McpDependencies["storyboardRepository"]>),
        findForWorkspace: async () => ({ ...board(renderer), canvas }) as Storyboard,
      },
      assetRepository: {
        findForWorkspace: async () => null,
        findByMetadata: async ({ key, value }: { key: string; value: string }) =>
          assets.find((asset) => asset.metadata?.[key] === value) ?? null,
        create: async (asset: Asset) => {
          assets.push(asset);
          return asset;
        },
        updateState: async ({ assetId }: { assetId: string }) => {
          const asset = assets.find((entry) => entry.id === assetId);
          return asset ? { ...asset, state: "active" } : null;
        },
      } as unknown as NonNullable<McpDependencies["assetRepository"]>,
      assetStore: {
        putObject: async ({ assetId }: { assetId: string }) => {
          stored.push(assetId);
        },
      } as unknown as NonNullable<McpDependencies["assetStore"]>,
      sceneRasterizer: async (_svg: string, size: { width: number; height: number }) => {
        sizes.push(size);
        rasterized += 1;
        return new Uint8Array([137, 80, 78, 71, rasterized]);
      },
    };
    return { deps, assets, stored, sizes, rasterizedCount: () => rasterized };
  };

  it("stores one still per scene and returns public urls", async () => {
    const { deps, assets, stored } = previewFixture();
    const result = await previewVideoStoryboardTool(
      { workspaceId, storyboardId: "board-stick" },
      actorId,
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scenes = result.value.scenes as { index: number; assetId: string; url: string }[];
    expect(scenes.map((scene) => scene.index)).toEqual([1, 2, 3]);
    expect(stored).toHaveLength(3);
    expect(assets.every((asset) => asset.metadata?.role === "scene_preview")).toBe(true);
    expect(assets.every((asset) => asset.width === 1080 && asset.height === 1920)).toBe(true);
    expect(scenes[0]?.url).toBe(
      `https://api.example.com/v1/public/workspaces/${workspaceId}/assets/${scenes[0]?.assetId}`,
    );
    expect(result.value.hookFrameAssetId).toBe(scenes[0]?.assetId);
    expect(typeof result.value.estimatedSeconds).toBe("number");
  });

  it("previews a landscape storyboard at 1920x1080", async () => {
    const { deps, assets, sizes } = previewFixture("stickman_still", "landscape");
    const result = await previewVideoStoryboardTool(
      { workspaceId, storyboardId: "board-stick" },
      actorId,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(sizes.every((size) => size.width === 1920 && size.height === 1080)).toBe(true);
    expect(assets.every((asset) => asset.width === 1920 && asset.height === 1080)).toBe(true);
  });

  it("reuses stills for scenes that did not change", async () => {
    const { deps, rasterizedCount } = previewFixture();
    await previewVideoStoryboardTool({ workspaceId, storyboardId: "board-stick" }, actorId, deps);
    await previewVideoStoryboardTool({ workspaceId, storyboardId: "board-stick" }, actorId, deps);
    expect(rasterizedCount()).toBe(3);
  });

  it("rejects slideshow storyboards", async () => {
    const { deps } = previewFixture("slideshow");
    const result = await previewVideoStoryboardTool(
      { workspaceId, storyboardId: "board-slides" },
      actorId,
      deps,
    );
    expect(result).toEqual({ ok: false, error: "NICHE_KIND_MISMATCH" });
  });
});

describe("create_video_storyboard with ai_clips scenes", () => {
  const clipScene = (index: number, fromChar: number, toChar: number, over = {}) => ({
    index,
    fromChar,
    toChar,
    clipPrompt: "A quiet kitchen at dawn, steam rising from a mug",
    captionMode: "word",
    ...over,
  });
  const optedIn = { characters: [alex], experiments: { allowTrialRenderers: true } };
  const input = (over: Record<string, unknown> = {}) => ({
    workspaceId,
    scriptId: "script-media",
    renderer: "ai_clips",
    voiceId: "af_heart",
    canvas: "portrait",
    scenes: [clipScene(1, 0, 15), clipScene(2, 15, 30)],
    ...over,
  });
  it("refuses ai_clips unless the niche opted into trial renderers", async () => {
    const { deps } = fixture();
    expect(await createVideoStoryboardTool(input(), actorId, deps)).toEqual({
      ok: false,
      error: "TRIAL_RENDERER_NOT_ENABLED",
    });
  });
  it("stores clip scenes with their prompts", async () => {
    const { deps, storyboards } = fixture(optedIn);
    const result = await createVideoStoryboardTool(input(), actorId, deps);
    expect(result).toMatchObject({ ok: true, value: { renderer: "ai_clips", totalScenes: 2 } });
    expect(storyboards[0]?.scenes[0]).toMatchObject({ clipPrompt: expect.any(String) });
  });
  it("needs an explicit voice, a portrait canvas and an owned reference image", async () => {
    const { deps } = fixture(optedIn);
    expect(await createVideoStoryboardTool(input({ voiceId: undefined }), actorId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    expect(await createVideoStoryboardTool(input({ canvas: "landscape" }), actorId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    const withReference = input({
      scenes: [clipScene(1, 0, 15, { referenceAssetId: "missing" }), clipScene(2, 15, 30)],
    });
    expect(await createVideoStoryboardTool(withReference, actorId, deps)).toEqual({
      ok: false,
      error: "STORYBOARD_ASSET_INVALID:unknown",
    });
  });
  it("rejects a prompt over 400 characters", async () => {
    const { deps } = fixture(optedIn);
    const long = input({ scenes: [clipScene(1, 0, 30, { clipPrompt: "x".repeat(401) })] });
    expect(await createVideoStoryboardTool(long, actorId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
  });
});
