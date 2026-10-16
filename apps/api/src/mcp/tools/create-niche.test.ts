import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { McpDependencies } from "../server.js";
import { createNicheTool } from "./create-niche.js";
import { listNichesTool } from "./list-niches.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const deps = (stored: Niche[]): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "W" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "W" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
    addMembership: async () => undefined,
  },
  nicheRepository: {
    create: async (niche) => {
      stored.push(niche);
      return niche;
    },
    listForWorkspace: async () => stored,
    findForWorkspace: async () => null,
    updateState: async () => null,
  },
});

const input = {
  workspaceId,
  name: "How The World Works",
  audience: "curious adults",
  problem: "systems feel opaque",
  editorialVoice: "clear",
  languages: ["en-US"],
  monetizationHypothesis: "none",
};

describe("niche kind tools", () => {
  it("creates a media niche", async () => {
    const stored: Niche[] = [];
    const result = await createNicheTool({ ...input, kind: "media" }, actorId, deps(stored));
    expect(result.ok && (result.value.niche as Niche).kind).toBe("media");
  });

  it("creates an affiliate niche when kind is omitted", async () => {
    const stored: Niche[] = [];
    await createNicheTool(input, actorId, deps(stored));
    expect(stored[0]?.kind).toBe("affiliate");
  });

  it("lists niches filtered by kind", async () => {
    const stored: Niche[] = [];
    const d = deps(stored);
    await createNicheTool({ ...input, kind: "media" }, actorId, d);
    await createNicheTool({ ...input, name: "Casa" }, actorId, d);
    const result = await listNichesTool({ workspaceId, kind: "media" }, actorId, d);
    expect(result.ok && (result.value.niches as Niche[]).map((n) => n.name)).toEqual([
      "How The World Works",
    ]);
  });
});
