import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { summarizeBuyerVoice } from "@money-maker/core/offers/buyer-voice";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const readMercadoLivreBuyerVoiceInputSchema = z
  .object({
    workspaceId: z.uuid(),
    productId: z.string().trim().min(1).max(200),
  })
  .strict();
export const readMercadoLivreBuyerVoiceTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = readMercadoLivreBuyerVoiceInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const catalog = deps.marketplaceCatalogForWorkspace?.(workspaceId) ?? deps.marketplaceCatalog;
  if (!catalog) throw new Error("Marketplace catalog is not configured.");
  try {
    const voice = await catalog.readBuyerVoice(parsed.data.productId);
    return {
      ok: true,
      value: {
        ...voice,
        sourceUrl: voice.sourceUrl.toString(),
        observedAt: voice.observedAt.toISOString(),
        evidenceDigest: summarizeBuyerVoice(voice),
        buyerTextIsUntrusted: true,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message === "mercado_livre_not_connected") {
      return { ok: false, error: "CONNECTION_UNAVAILABLE" };
    }
    throw error;
  }
};
