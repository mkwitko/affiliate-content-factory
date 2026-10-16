import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";
export const reconcilePublicationInputSchema = z
  .object({ workspaceId: z.uuid(), attemptId: z.string().trim().min(1).max(200) })
  .strict();
export const reconcilePublicationTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = reconcilePublicationInputSchema.safeParse(args);
  if (
    !parsed.success ||
    !deps.publicationAttempts ||
    !deps.providerConnections ||
    !deps.socialPublisherForWorkspace
  )
    return parsed.success
      ? (() => {
          throw new Error("Publication reconciliation dependencies are not configured.");
        })()
      : { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const attempt = await deps.publicationAttempts.findForWorkspace({
    workspaceId,
    attemptId: parsed.data.attemptId,
  });
  if (!attempt) return { ok: false, error: "NOT_FOUND" };
  if (attempt.status !== "unknown_outcome")
    return { ok: false, error: "PUBLICATION_NOT_RECONCILABLE" };
  const connection = await deps.providerConnections.findForWorkspace({
    workspaceId,
    connectionId: attempt.connectionId,
  });
  if (connection?.status !== "active") return { ok: false, error: "CONNECTION_UNAVAILABLE" };
  try {
    const result = await deps.socialPublisherForWorkspace(workspaceId).reconcile({
      secretReference: connection.secretReference,
      accountId: connection.accountId,
      externalId: attempt.attemptId,
    });
    if (result.status === "published") {
      await deps.publicationAttempts.recordPublished({
        workspaceId,
        attemptId: attempt.attemptId,
        externalId: result.externalId,
      });
    } else if (result.status === "failed") {
      await deps.publicationAttempts.recordFailure({
        workspaceId,
        attemptId: attempt.attemptId,
        status: "permanent_failure",
        reason: `provider_post_failed: ${result.failureReason ?? "provider_post_failed"}`,
      });
    }
    const publication = await deps.publicationAttempts.findForWorkspace({
      workspaceId,
      attemptId: attempt.attemptId,
    });
    return publication ? { ok: true, value: { publication } } : { ok: false, error: "NOT_FOUND" };
  } catch (error: unknown) {
    return error instanceof Error && error.message === "provider_unknown_outcome"
      ? { ok: false, error: "PUBLICATION_STILL_UNKNOWN" }
      : { ok: false, error: "INTERNAL_ERROR" };
  }
};
