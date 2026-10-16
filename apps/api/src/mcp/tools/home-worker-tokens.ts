import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { UserId } from "@money-maker/contracts";
import {
  describeToken,
  HOME_CAPABILITIES,
  issueHomeWorkerToken,
} from "@money-maker/core/home-worker/tokens";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

/**
 * Home worker tokens (ADR 0012): the owner issues a token for a home machine, sees it once,
 * and can revoke it. The token only reaches /v1/home-worker/* for its workspace and capabilities.
 */
export const createHomeWorkerTokenInputSchema = z
  .object({
    workspaceId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    capabilities: z.array(z.enum(HOME_CAPABILITIES)).min(1).max(HOME_CAPABILITIES.length),
  })
  .strict();
export const listHomeWorkerTokensInputSchema = z.object({ workspaceId: z.uuid() }).strict();
export const revokeHomeWorkerTokenInputSchema = z
  .object({ workspaceId: z.uuid(), tokenId: z.uuid() })
  .strict();

const sha256 = async (plain: string) => createHash("sha256").update(plain).digest("hex");

export const createHomeWorkerTokenTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createHomeWorkerTokenInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.homeWorkerTokens) throw new Error("Home worker tokens are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  const { plain, token } = await issueHomeWorkerToken(
    deps.homeWorkerTokens,
    {
      random: () => randomBytes(32).toString("base64url"),
      hash: sha256,
      now: () => new Date(),
      id: randomUUID,
    },
    {
      workspaceId,
      name: parsed.data.name,
      capabilities: parsed.data.capabilities,
      createdById: actorId,
    },
  );
  await deps.audit?.record({
    action: "home_worker.token.created",
    workspaceId,
    actorUserId: actorId,
    targetType: "HomeWorkerToken",
    targetId: token.id,
    metadata: { capabilities: token.capabilities.join(",") },
  });
  return {
    ok: true,
    value: {
      token: describeToken(token),
      // Shown once; only its hash is stored. It goes in MONEY_MAKER_HOME_TOKEN on the home machine.
      plainToken: plain,
    },
  };
};

export const listHomeWorkerTokensTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = listHomeWorkerTokensInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.homeWorkerTokens) throw new Error("Home worker tokens are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const tokens = await deps.homeWorkerTokens.listForWorkspace(workspaceId);
  return { ok: true, value: { tokens: tokens.map(describeToken) } };
};

export const revokeHomeWorkerTokenTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = revokeHomeWorkerTokenInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.homeWorkerTokens) throw new Error("Home worker tokens are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner"]);
  if (denied) return denied;
  const revoked = await deps.homeWorkerTokens.revoke({
    workspaceId,
    id: parsed.data.tokenId,
    at: new Date(),
  });
  if (!revoked) return { ok: false, error: "NOT_FOUND" };
  await deps.audit?.record({
    action: "home_worker.token.revoked",
    workspaceId,
    actorUserId: actorId,
    targetType: "HomeWorkerToken",
    targetId: revoked.id,
    metadata: {},
  });
  return { ok: true, value: { token: describeToken(revoked) } };
};
