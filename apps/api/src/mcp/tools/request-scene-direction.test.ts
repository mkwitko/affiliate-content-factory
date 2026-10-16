import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ContentScript } from "@money-maker/core/content/editorial";
import { describe, expect, it, vi } from "vitest";
import type { McpDependencies } from "../server.js";
import { requestSceneDirectionTool } from "./request-scene-direction.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const actorId = parseUserId("22222222-2222-4222-8222-222222222222");
const approved = { id: "script-1", workspaceId, status: "approved" } as ContentScript;
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
  editorialRepository: { findScriptForWorkspace: vi.fn(async () => approved) } as never,
  jobQueue: { enqueue: vi.fn(async (input) => ({ id: "job-1", ...input })) } as never,
  sceneDirectionAvailable: true,
  ...overrides,
});
const args = { workspaceId, scriptId: "script-1" };

describe("request_scene_direction", () => {
  it("queues one direct_scenes job with only the script id in the envelope", async () => {
    const deps = dependencies();
    expect(await requestSceneDirectionTool(args, actorId, deps)).toEqual({
      ok: true,
      value: { jobId: "job-1", scriptId: "script-1", status: "queued" },
    });
    expect(deps.jobQueue?.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "direct_scenes",
        payload: { version: 1, workspaceId, identifiers: { scriptId: "script-1" } },
        idempotencyKey: "direct-scenes:script-1",
      }),
    );
  });

  it("is refused unless scene direction is configured", async () => {
    const deps = dependencies({ sceneDirectionAvailable: false });
    expect(await requestSceneDirectionTool(args, actorId, deps)).toEqual({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    expect(deps.jobQueue?.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a script that is not approved", async () => {
    const deps = dependencies({
      editorialRepository: {
        findScriptForWorkspace: async () => ({ ...approved, status: "draft" }),
      } as never,
    });
    expect(await requestSceneDirectionTool(args, actorId, deps)).toEqual({
      ok: false,
      error: "SCRIPT_NOT_APPROVED",
    });
    expect(deps.jobQueue?.enqueue).not.toHaveBeenCalled();
  });

  it("denies a viewer", async () => {
    const deps = dependencies({
      workspaces: {
        findMembership: async () => ({
          workspaceId,
          userId: actorId,
          role: "viewer",
          status: "active",
        }),
      } as never,
    });
    const result = await requestSceneDirectionTool(args, actorId, deps);
    expect(result.ok).toBe(false);
    expect(deps.jobQueue?.enqueue).not.toHaveBeenCalled();
  });
});
