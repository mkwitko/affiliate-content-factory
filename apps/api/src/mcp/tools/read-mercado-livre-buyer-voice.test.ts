import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { McpDependencies } from "../server.js";
import { readMercadoLivreBuyerVoiceTool } from "./read-mercado-livre-buyer-voice.js";

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
  readBuyerVoice: () => ReturnType<typeof voice>,
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
    readBuyerVoice,
  }),
});

const voice = async () => ({
  providerId: "MLB1",
  sourceUrl: new URL("https://www.mercadolivre.com.br/p/MLB1"),
  observedAt: new Date("2026-09-23T12:00:00Z"),
  ratingAverage: 4.5,
  reviewCount: 10,
  positiveReviews: [{ rating: 5, title: "Firme", text: "Aguenta bem" }],
  negativeReviews: [],
  questions: [{ question: "Cabe 17?", answer: "Sim" }],
  pictures: [],
  unavailable: [],
});

describe("read_mercado_livre_buyer_voice MCP tool", () => {
  it("returns serialized buyer voice marked as untrusted", async () => {
    const result = await readMercadoLivreBuyerVoiceTool(
      { workspaceId, productId: "MLB1" },
      actorId,
      dependencies(voice),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
        observedAt: "2026-09-23T12:00:00.000Z",
        questions: [{ question: "Cabe 17?", answer: "Sim" }],
        evidenceDigest: {
          method: "exact_normalized_text_v1",
          positiveReviewCount: 1,
          negativeReviewCount: 0,
          questionCount: 1,
        },
        buyerTextIsUntrusted: true,
      },
    });
  });
  it("rejects invalid arguments", async () => {
    const result = await readMercadoLivreBuyerVoiceTool(
      { workspaceId, productId: "" },
      actorId,
      dependencies(voice),
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
  it("denies users outside the workspace", async () => {
    const result = await readMercadoLivreBuyerVoiceTool(
      { workspaceId, productId: "MLB1" },
      actorId,
      dependencies(voice, false),
    );
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ ok: true });
  });
  it("reports a missing Mercado Livre connection", async () => {
    const result = await readMercadoLivreBuyerVoiceTool(
      { workspaceId, productId: "MLB1" },
      actorId,
      dependencies(async () => {
        throw new Error("mercado_livre_not_connected");
      }),
    );
    expect(result).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });
});
