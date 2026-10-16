import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { TrendKeyword } from "@money-maker/core/offers/marketplace-catalog";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { researchTrendsTool } from "./research-trends.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces = (member: boolean): WorkspaceRepository => ({
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => (member ? { id: workspaceId, name: "Workspace" } : null),
  findMembership: async () =>
    member ? { workspaceId, userId: actorId, role: "owner", status: "active" } : null,
  addMembership: async () => undefined,
});

const dependencies = (
  readTrends: (categoryId?: string) => Promise<readonly TrendKeyword[]>,
  member = true,
): McpDependencies => ({
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: workspaces(member),
  marketplaceCatalogForWorkspace: () => ({
    search: async () => [],
    readProductEvidence: async () => {
      throw new Error("not_used");
    },
    readBuyerVoice: async () => {
      throw new Error("not_used");
    },
    readTrends,
  }),
});

describe("research_trends MCP tool", () => {
  it("returns ranked trend keywords with hashtag candidates", async () => {
    const categories: (string | undefined)[] = [];
    const result = await researchTrendsTool(
      { workspaceId, categoryId: "MLB1574", limit: 2 },
      actorId,
      dependencies(async (categoryId) => {
        categories.push(categoryId);
        return [
          { keyword: "tapete sala", url: null },
          { keyword: "2026", url: null },
          { keyword: "cortina", url: null },
        ];
      }),
    );
    expect(categories).toEqual(["MLB1574"]);
    expect(result).toMatchObject({
      ok: true,
      value: {
        source: "mercado_livre_trends",
        categoryId: "MLB1574",
        trends: [
          { rank: 1, keyword: "tapete sala", hashtag: "#tapetesala" },
          { rank: 2, keyword: "2026", hashtag: null },
        ],
        instagramHashtagLimit: 5,
      },
    });
  });

  it("rejects a malformed category before calling the provider", async () => {
    const result = await researchTrendsTool(
      { workspaceId, categoryId: "../users/me" },
      actorId,
      dependencies(async () => {
        throw new Error("not_used");
      }),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("denies a non-member", async () => {
    const result = await researchTrendsTool(
      { workspaceId },
      actorId,
      dependencies(async () => [], false),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ ok: true });
  });

  it("maps provider errors", async () => {
    const failing = (message: string) =>
      researchTrendsTool(
        { workspaceId, categoryId: "MLB9" },
        actorId,
        dependencies(async () => {
          throw new Error(message);
        }),
      );
    await expect(failing("mercado_livre_not_connected")).resolves.toEqual({
      ok: false,
      error: "CONNECTION_UNAVAILABLE",
    });
    await expect(failing("category_not_found")).resolves.toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    await expect(failing("rate_limited")).rejects.toThrow("rate_limited");
  });
});
