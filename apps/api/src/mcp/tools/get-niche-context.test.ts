import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { ResearchRepository } from "@money-maker/core/research/research-repository";
import type { ResearchSnapshot } from "@money-maker/core/research/research-snapshot";
import type { McpDependencies } from "../server.js";
import { nicheContextSchema } from "./editorial-context.js";
import { getNicheContextTool } from "./get-niche-context.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({
    workspaceId,
    userId: actorId,
    role: "reviewer",
    status: "active",
  }),
  addMembership: async () => undefined,
};

const niche = {
  id: "niche-1",
  workspaceId,
  name: "Cafeteiras portáteis",
  audience: "Viajantes",
  problem: "Café ruim em viagem",
  editorialVoice: "Direto",
  languages: ["pt-BR"],
  monetizationHypothesis: "Afiliados",
  state: "active" as const,
  kind: "affiliate" as const,
  context: { promise: "Café bom em qualquer lugar" },
};

const activeSnapshot: ResearchSnapshot = {
  id: "snapshot-1",
  workspaceId,
  provider: "manual",
  nicheId: "niche-1",
  query: "cafeteira portátil",
  locale: "pt-BR",
  observedAt: new Date("2026-09-21T00:00:00.000Z"),
  expiresAt: new Date("2026-09-28T00:00:00.000Z"),
  observations: [
    { id: "obs-1", key: "keyword", value: "cafeteira portátil", sourceUrl: "https://example.test" },
  ],
  contentHash: "hash-1",
  actorId,
};

describe("get_niche_context MCP tool", () => {
  it("returns the niche context merged with active research observations", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [niche],
      findForWorkspace: async ({ nicheId }) => (nicheId === "niche-1" ? niche : null),
      updateState: async () => null,
    };
    const researchRepository: ResearchRepository = {
      create: async (value) => value,
      findByHash: async () => null,
      findActiveForNiche: async () => [activeSnapshot],
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
      researchRepository,
    };

    const result = await getNicheContextTool(
      { workspaceId, nicheId: "niche-1" },
      actorId,
      dependencies,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        niche: { id: "niche-1", context: { promise: "Café bom em qualquer lugar" } },
        resolvedCaptionTheme: null,
        research: {
          keywords: ["cafeteira portátil"],
          pains: [],
          referenceProducts: [],
          exclusions: [],
        },
      },
    });
  });

  it("returns NOT_FOUND for a niche outside the caller's workspace", async () => {
    const nicheRepository: NicheRepository = {
      create: async (value) => value,
      listForWorkspace: async () => [],
      findForWorkspace: async () => null,
      updateState: async () => null,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      nicheRepository,
    };

    const result = await getNicheContextTool(
      { workspaceId, nicheId: "missing" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

describe("niche context caption theme", () => {
  it("accepts a valid captionTheme and rejects unknown fields and bad colours", () => {
    const ok = nicheContextSchema.safeParse({
      captionTheme: { preset: "karaoke", useBrandColors: true, maxWords: 2 },
    });
    expect(ok.success).toBe(true);
    expect(nicheContextSchema.safeParse({ captionTheme: { baseColor: "red" } }).success).toBe(
      false,
    );
    expect(nicheContextSchema.safeParse({ captionTheme: { preset: "neon" } }).success).toBe(false);
    expect(nicheContextSchema.safeParse({ captionTheme: { extra: 1 } }).success).toBe(false);
  });

  it("validates music moods and volume", () => {
    expect(
      nicheContextSchema.safeParse({ music: { moods: ["calm"], volume: "low" } }).success,
    ).toBe(true);
    expect(nicheContextSchema.safeParse({ music: { moods: ["loud"] } }).success).toBe(false);
    expect(nicheContextSchema.safeParse({ music: { volume: "max" } }).success).toBe(false);
  });

  it("validates videoMark opacity and position", () => {
    expect(
      nicheContextSchema.safeParse({ videoMark: { enabled: true, opacity: 0.5 } }).success,
    ).toBe(true);
    expect(
      nicheContextSchema.safeParse({ videoMark: { enabled: true, opacity: 0.1 } }).success,
    ).toBe(false);
    expect(
      nicheContextSchema.safeParse({ videoMark: { enabled: true, position: "center" } }).success,
    ).toBe(false);
    expect(nicheContextSchema.safeParse({ videoMark: {} }).success).toBe(false);
  });
});
