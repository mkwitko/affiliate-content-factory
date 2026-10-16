import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument, requireList } from "./workspace-access.js";
export const listNichesInputSchema = z
  .object({ workspaceId: z.uuid(), kind: z.enum(["affiliate", "media"]).optional() })
  .strict();
export const listNichesTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listNichesInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;
  const repo = deps.nicheRepository;
  const all = await requireList(repo)(workspaceId);
  const kind = parsed.data.kind;
  const niches = kind ? all.filter((niche) => niche.kind === kind) : all;
  const base = deps.publicApiUrl?.replace(/\/$/, "");
  return {
    ok: true,
    value: {
      // bioLinkUrl goes in the Instagram bio once: it opens a storefront page of every active offer.
      niches: niches.map((niche) =>
        niche.slug && base ? { ...niche, bioLinkUrl: `${base}/go/n/${niche.slug}` } : niche,
      ),
    },
  };
};
