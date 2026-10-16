import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { getBrandContextTool } from "./get-brand-context.js";
import { updateBrandContextTool } from "./update-brand-context.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspacesWithContext = (
  initial: Record<string, unknown> | null,
  role: "owner" | "reviewer",
) => {
  let stored = initial;
  const workspaces: WorkspaceRepository = {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    addMembership: async () => undefined,
    getContext: async () => stored,
    updateContext: async ({ context }) => {
      stored = context;
    },
  };
  return workspaces;
};

describe("brand context MCP tools", () => {
  it("reads the stored brand context", async () => {
    const workspaces = workspacesWithContext({ mission: "Example Shop" }, "reviewer");
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
    };

    const result = await getBrandContextTool({ workspaceId }, actorId, dependencies);
    expect(result).toEqual({ ok: true, value: { context: { mission: "Example Shop" } } });
  });

  it("updates the brand context for owners", async () => {
    const workspaces = workspacesWithContext(null, "owner");
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
    };

    const result = await updateBrandContextTool(
      { workspaceId, context: { mission: "Example Shop", cta: "Compre agora" } },
      actorId,
      dependencies,
    );
    expect(result).toEqual({
      ok: true,
      value: { context: { mission: "Example Shop", cta: "Compre agora" } },
    });
    await expect(getBrandContextTool({ workspaceId }, actorId, dependencies)).resolves.toEqual({
      ok: true,
      value: { context: { mission: "Example Shop", cta: "Compre agora" } },
    });
  });

  it("forbids reviewers from updating the brand context", async () => {
    const workspaces = workspacesWithContext(null, "reviewer");
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
    };

    const result = await updateBrandContextTool(
      { workspaceId, context: { mission: "Example Shop" } },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
