import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentScript } from "@money-maker/core/content/editorial";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { requestStoryboardScenesTool } from "./request-storyboard-scenes.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const script = {
  id: "script-1",
  workspaceId,
  contentItemId: "item-1",
  status: "approved",
} as ContentScript;
const plan = {
  role: "hero",
  productAnchor: "center",
  surface: "table",
  lighting: "soft-front",
  nicheSetting: "home kitchen",
  paletteHint: "blue",
};
const dependencies = (overrides: Partial<McpDependencies> = {}): McpDependencies => ({
  authenticate: async () => null,
  invitation: {} as never,
  workspaces: {
    findMembership: async () => ({
      workspaceId,
      userId: actorId,
      role: "operator",
      status: "active",
    }),
  } as never,
  editorialRepository: { findScriptForWorkspace: vi.fn(async () => script) } as never,
  contentRepository: {
    findContentItemForWorkspace: vi.fn(async () => ({ id: "item-1", nicheId: "niche-1" })),
  } as never,
  requestStoryboardScene: vi.fn(async () => ({ assetId: "scene-1", source: "generated" as const })),
  ...overrides,
});

describe("request_storyboard_scenes", () => {
  it("requests scenes through the creative pipeline and correlates usage to the script", async () => {
    const deps = dependencies();
    const result = await requestStoryboardScenesTool(
      { workspaceId, scriptId: script.id, requests: [{ index: 1, plan }] },
      actorId,
      deps,
    );
    expect(result).toEqual({
      ok: true,
      value: { scenes: [{ index: 1, assetId: "scene-1", source: "generated" }] },
    });
    expect(deps.requestStoryboardScene).toHaveBeenCalledWith({
      workspaceId,
      nicheId: "niche-1",
      plan,
      correlationId: script.id,
    });
  });

  it("does not request generation for an unapproved script", async () => {
    const deps = dependencies({
      editorialRepository: {
        findScriptForWorkspace: vi.fn(async () => ({ ...script, status: "draft" })),
      } as never,
    });
    await expect(
      requestStoryboardScenesTool(
        { workspaceId, scriptId: script.id, requests: [{ index: 1, plan }] },
        actorId,
        deps,
      ),
    ).resolves.toEqual({ ok: false, error: "SCRIPT_NOT_APPROVED" });
    expect(deps.requestStoryboardScene).not.toHaveBeenCalled();
  });

  it("does not request image generation when the approved script starts with a generic hook", async () => {
    const deps = dependencies({
      editorialRepository: {
        findScriptForWorkspace: vi.fn(async () => ({
          ...script,
          body: "Você não vai acreditar no que aconteceu. A história começa...",
        })),
      } as never,
    });
    await expect(
      requestStoryboardScenesTool(
        { workspaceId, scriptId: script.id, requests: [{ index: 1, plan }] },
        actorId,
        deps,
      ),
    ).resolves.toEqual({ ok: false, error: "CREATIVE_QUALITY_REJECTED:generic_hook" });
    expect(deps.requestStoryboardScene).not.toHaveBeenCalled();
  });
});
