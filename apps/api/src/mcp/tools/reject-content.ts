import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import {
  REVIEW_REASONS,
  rejectionText,
  rejectVariant,
  submitForReview,
} from "@money-maker/core/content/approval";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";

export const rejectContentInputSchema = z
  .object({
    workspaceId: z.uuid(),
    variantId: z.string().trim().min(1).max(200),
    reason: z.string().trim().max(1_000).default(""),
    reasons: z
      .array(z.enum(REVIEW_REASONS))
      .max(5)
      .optional()
      .describe("Typed review reasons; they label the outcome for model and decision benchmarks."),
  })
  .strict()
  .refine((value) => value.reason.length > 0 || (value.reasons?.length ?? 0) > 0)
  .describe(
    "Reject one workspace-owned content variant (draft or awaiting review) with typed reasons and/or a note.",
  );

export const rejectContentTool = async (
  arguments_: unknown,
  actorId: UserId,
  dependencies: McpDependencies,
): Promise<ToolResult> => {
  const parsed = rejectContentInputSchema.safeParse(arguments_);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceId(parsed.data.workspaceId);
  const authorization = authorizeWorkspace({
    actorId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId: actorId }),
    allowedRoles: ["owner", "operator", "reviewer"],
  });
  if (!authorization.ok) return { ok: false, error: "FORBIDDEN" };
  if (!dependencies.contentRepository) throw new Error("Approval dependencies are not configured.");
  const variant = await dependencies.contentRepository.findVariantForWorkspace({
    workspaceId,
    variantId: parsed.data.variantId,
  });
  if (!variant) return { ok: false, error: "CONTENT_NOT_FOUND" };
  try {
    // A draft previewed in chat was never submitted; submit it first, as approve_content does.
    const reviewable = variant.state === "draft" ? submitForReview(variant) : variant;
    const rejected = rejectVariant(
      reviewable,
      rejectionText(parsed.data.reasons ?? [], parsed.data.reason),
    );
    return {
      ok: true,
      value: { variant: await dependencies.contentRepository.updateVariant(rejected) },
    };
  } catch {
    return { ok: false, error: "INVALID_CONTENT" };
  }
};
