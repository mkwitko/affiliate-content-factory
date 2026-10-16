import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { updateNicheTool } from "./update-niche.js";
import { updateNicheContextTool } from "./update-niche-context.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
};

const baseNiche: Niche = {
  id: "niche-1",
  workspaceId,
  name: "Cafeteiras portáteis",
  audience: "Viajantes",
  problem: "Café ruim em viagem",
  editorialVoice: "Direto",
  languages: ["pt-BR"],
  monetizationHypothesis: "Afiliados",
  state: "active",
  kind: "affiliate",
};

describe("niche editing MCP tools", () => {
  it("updates only the provided base fields", async () => {
    let stored = baseNiche;
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [stored],
      findForWorkspace: async () => stored,
      updateState: async () => null,
      update: async ({ nicheId, ...changes }) => {
        if (nicheId !== stored.id) return null;
        stored = { ...stored, ...changes };
        return stored;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheTool(
      { workspaceId, nicheId: "niche-1", audience: "Nômades digitais" },
      actorId,
      dependencies,
    );

    expect(result).toMatchObject({ ok: true, value: { niche: { audience: "Nômades digitais" } } });
    expect(stored.name).toBe("Cafeteiras portáteis");
  });

  it("activates a draft niche for the owner and refuses the state change to an operator", async () => {
    let stored: Niche = { ...baseNiche, state: "draft" };
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [stored],
      findForWorkspace: async () => stored,
      updateState: async ({ nicheId, state }) => {
        if (nicheId !== stored.id) return null;
        stored = { ...stored, state };
        return stored;
      },
      update: async () => stored,
    };
    const audits: unknown[] = [];
    const deps = (role: "owner" | "operator"): McpDependencies => ({
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces: {
        ...workspaces,
        findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
      },
      nicheRepository,
      audit: {
        record: async (event) => {
          audits.push(event);
          return "audit-1";
        },
      },
    });

    const refused = await updateNicheTool(
      { workspaceId, nicheId: "niche-1", state: "active" },
      actorId,
      deps("operator"),
    );
    expect(refused).toMatchObject({ ok: false });
    expect(stored.state).toBe("draft");

    const result = await updateNicheTool(
      { workspaceId, nicheId: "niche-1", state: "active" },
      actorId,
      deps("owner"),
    );
    expect(result).toMatchObject({ ok: true, value: { niche: { state: "active" } } });
    expect(audits).toEqual([
      expect.objectContaining({
        action: "niche.state_changed",
        metadata: { from: "draft", to: "active" },
      }),
    ]);
  });

  it("returns NOT_FOUND for a niche outside the workspace", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [],
      findForWorkspace: async () => null,
      updateState: async () => null,
      update: async () => null,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheTool(
      { workspaceId, nicheId: "missing", name: "x" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("stores a bounded niche context", async () => {
    let stored = baseNiche;
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [stored],
      findForWorkspace: async () => stored,
      updateState: async () => null,
      updateContext: async ({ context }) => {
        stored = { ...stored, context };
        return stored;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheContextTool(
      { workspaceId, nicheId: "niche-1", context: { promise: "Café bom em qualquer lugar" } },
      actorId,
      dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { niche: { context: { promise: "Café bom em qualquer lugar" } } },
    });
  });

  it("stores a valid Kokoro voice id", async () => {
    let stored = baseNiche;
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [stored],
      findForWorkspace: async () => stored,
      updateState: async () => null,
      updateContext: async ({ context }) => {
        stored = { ...stored, context };
        return stored;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheContextTool(
      { workspaceId, nicheId: "niche-1", context: { voiceId: "pf_dora" } },
      actorId,
      dependencies,
    );

    expect(result).toMatchObject({
      ok: true,
      value: { niche: { context: { voiceId: "pf_dora" } } },
    });
  });

  it("rejects a malformed voice id", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [baseNiche],
      findForWorkspace: async () => baseNiche,
      updateState: async () => null,
      updateContext: async () => baseNiche,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheContextTool(
      { workspaceId, nicheId: "niche-1", context: { voiceId: "Dora!" } },
      actorId,
      dependencies,
    );

    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects a niche context payload with an unknown key", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [baseNiche],
      findForWorkspace: async () => baseNiche,
      updateState: async () => null,
      updateContext: async () => baseNiche,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await updateNicheContextTool(
      { workspaceId, nicheId: "niche-1", context: { unknownField: "x" } },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("returns silhouette advice when two or more cast members have a bible", async () => {
    let stored: Niche = { ...baseNiche, kind: "media" };
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [stored],
      findForWorkspace: async () => stored,
      updateState: async () => null,
      updateContext: async ({ context }) => {
        stored = { ...stored, context };
        return stored;
      },
    };
    const masked: string[] = [];
    const mask = { width: 2, height: 2, data: new Uint8Array([1, 1, 1, 0]) };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      silhouetteMasks: async (cast) => {
        masked.push(...cast.map((c) => c.key));
        return new Map(cast.map((c) => [c.key, [mask, mask, mask]]));
      },
    };
    const character = (key: string) => ({
      key,
      name: key,
      description: `${key} is on the cast`,
      rigId: "stick-v1",
      rigVersion: 1,
      palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
      bible: { version: 1, role: "lead", body: { archetype: "average", head: "circle" } },
    });
    const result = await updateNicheContextTool(
      {
        workspaceId,
        nicheId: "niche-1",
        context: { characters: [character("ana"), character("bob")] },
      },
      actorId,
      dependencies,
    );
    expect(masked).toEqual(["ana", "bob"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        silhouetteWarnings: ["silhouette_iou:ana:bob", "silhouette_not_distinct:ana:bob"],
        silhouettePairs: [{ a: "ana", b: "bob", iou: 1 }],
      },
    });
  });
});
