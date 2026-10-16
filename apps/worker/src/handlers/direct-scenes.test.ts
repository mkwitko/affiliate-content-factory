import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createContentScript } from "@money-maker/core/content/editorial";
import type { Storyboard } from "@money-maker/core/content/storyboard";
import { PermanentJobError } from "@money-maker/core/jobs/job";
import { describe, expect, it, vi } from "vitest";
import { createDirectScenesHandler, type DirectScenesDependencies } from "./direct-scenes.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const body = "Essa air fryer custa R$ 329,90 hoje. A Carla comparou três modelos. Comprou a maior.";
const script = {
  ...createContentScript({
    workspaceId,
    contentItemId: "item-1",
    version: 1,
    body,
    language: "pt-BR",
    claims: [],
    beats: [],
    actorId,
  }),
  id: "script-1",
  status: "approved" as const,
};
// A director plan: one visual direction for each deterministically assigned scene.
const scene = (index: number, camera: object) => ({
  purpose: index === 1 ? "hook" : "payoff",
  background: index === 2 ? "office" : "kitchen",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  camera,
  transition: "hard_cut",
  captionMode: "word",
});
const threeScenes = [
  scene(1, { shot: "medium", movement: "none" }),
  scene(2, { shot: "close", movement: "push_in" }),
  scene(3, { shot: "wide", movement: "pan_left" }),
].map((visual) => ({ newScene: true as const, visual }));
const plan = { segments: threeScenes };

const niche = {
  id: "niche-1",
  kind: "media",
  context: {
    voiceId: "pf_dora",
    characters: [
      {
        key: "alex",
        name: "Alex",
        role: "main",
        rigId: "stick-v1",
        rigVersion: 1,
        palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
      },
    ],
  },
};

const setup = (output: unknown, overrides: Partial<DirectScenesDependencies> = {}) => {
  const created: Storyboard[] = [];
  const direct = vi.fn(async () => output);
  const deps: DirectScenesDependencies = {
    scripts: { findScriptForWorkspace: vi.fn(async () => script) } as never,
    content: { findContentItemForWorkspace: vi.fn(async () => ({ nicheId: "niche-1" })) } as never,
    niches: { findForWorkspace: vi.fn(async () => niche) } as never,
    storyboards: {
      findLatestForScript: vi.fn(async () => null),
      create: vi.fn(async (board: Storyboard) => {
        created.push(board);
        return board;
      }),
    } as never,
    director: { direct },
    ...overrides,
  };
  const run = () =>
    createDirectScenesHandler(deps)({
      payload: { version: 1, workspaceId, identifiers: { scriptId: "script-1" } },
    });
  return { run, created, direct };
};

describe("direct_scenes handler", () => {
  it("stores the validated direction as a stickman_motion draft", async () => {
    const { run, created } = setup(plan);
    await run();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      renderer: "stickman_motion",
      version: 1,
      canvas: "portrait",
    });
    expect(created[0]?.scenes).toHaveLength(3);
  });

  it("stores a long-form niche's direction on the landscape canvas", async () => {
    const longNiche = { ...niche, context: { ...niche.context, explainer: { format: "long" } } };
    const { run, created } = setup(plan, {
      niches: { findForWorkspace: vi.fn(async () => longNiche) } as never,
    });
    await run();
    expect(created[0]).toMatchObject({ renderer: "stickman_motion", canvas: "landscape" });
  });

  it("fails permanently on a rejected plan and stores nothing", async () => {
    const { run, created, direct } = setup("not json");
    await expect(run()).rejects.toThrow(PermanentJobError);
    expect(direct).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(0);
  });

  it("retries when the director cannot be reached", async () => {
    const { run } = setup(undefined, {
      director: {
        direct: async () => {
          throw new Error("scene_director_http_503");
        },
      },
    });
    await expect(run()).rejects.not.toBeInstanceOf(PermanentJobError);
  });

  it("refuses a script that is not approved", async () => {
    const { run, direct } = setup(plan, {
      scripts: {
        findScriptForWorkspace: async () => ({ ...script, status: "draft" }),
      } as never,
    });
    await expect(run()).rejects.toThrow(PermanentJobError);
    expect(direct).not.toHaveBeenCalled();
  });

  it("refuses a niche that is not an explainer niche", async () => {
    const { run } = setup(plan, {
      niches: { findForWorkspace: async () => ({ ...niche, kind: "product" }) } as never,
    });
    await expect(run()).rejects.toThrow(PermanentJobError);
  });
});
