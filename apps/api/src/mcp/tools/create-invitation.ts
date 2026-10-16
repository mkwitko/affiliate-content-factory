import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { createInvitation } from "@money-maker/core/identity/create-invitation";
import type { InvitationRole } from "@money-maker/core/identity/invitation-repository";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

export const createInvitationInputSchema = z
  .object({
    workspaceId: z.uuid(),
    email: z.email(),
    role: z.enum(["operator", "reviewer"]),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .describe("Create an invitation for a new workspace member.");

export const createInvitationTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createInvitationInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };

  const result = await createInvitation(
    {
      actorId,
      workspaceId: parseWorkspaceId(parsed.data.workspaceId),
      email: parsed.data.email,
      role: parsed.data.role as InvitationRole,
      expiresAt: new Date(parsed.data.expiresAt),
    },
    dependencies.invitation,
  );
  if (!result.ok) return { ok: false, error: result.error.code };

  return {
    ok: true,
    value: {
      invitation: {
        ...result.invitation,
        expiresAt: result.invitation.expiresAt.toISOString(),
      },
      token: result.token,
      auditId: result.auditId,
    },
  };
};
