import type { UserId } from "@money-maker/contracts";
import { editCreativeCopy } from "@money-maker/core/creatives/edit-creative-copy";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import type { ToolError } from "../tool-result.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const identifier = z.string().trim().min(1).max(200);

export const editCreativeCopyInputSchema = z
  .object({
    workspaceId: z.uuid(),
    contentItemId: identifier,
    slides: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            headline: z.string().max(60).optional(),
            body: z.string().max(140).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(7)
      .optional(),
    captions: z
      .array(
        z.object({ variantId: identifier, caption: z.string().trim().min(1).max(2200) }).strict(),
      )
      .min(1)
      .max(4)
      .optional(),
  })
  .strict()
  .describe(
    "Edit a draft post's slide headline/body or channel captions before approval. Prices and the discount badge are not editable text (they come from verified facts); numbers need a verified fact, no links, @handles or hashtags (the system adds the CTA and #publi). Refuses a post that already has an approved, scheduled or published variant. Scene art stays pinned; only the render is queued again (poll list_pending_content).",
  );

export const editCreativeCopyTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = editCreativeCopyInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.contentRepository || !deps.offerRepository || !deps.channelRepository || !deps.jobQueue)
    throw new Error("Creative edit dependencies are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const result = await editCreativeCopy(
    {
      content: deps.contentRepository,
      offers: deps.offerRepository,
      channels: deps.channelRepository,
      jobs: deps.jobQueue,
      ...(deps.reelRenders ? { reels: deps.reelRenders } : {}),
      now: () => new Date(),
    },
    {
      workspaceId,
      contentItemId: parsed.data.contentItemId,
      ...(parsed.data.slides ? { slides: parsed.data.slides } : {}),
      ...(parsed.data.captions ? { captions: parsed.data.captions } : {}),
    },
  );
  if (!result.ok) return { ok: false, error: result.error as ToolError };
  const variants = (await deps.contentRepository.listVariantsForWorkspace(workspaceId))
    .filter((variant) => variant.contentItemId === parsed.data.contentItemId)
    .filter((variant) => variant.state !== "cancelled");
  return {
    ok: true,
    value: {
      slidesChanged: result.value.slidesChanged,
      rerenderQueued: result.value.rerenderQueued,
      reelsStale: result.value.reelsStale,
      slides: result.value.slides.map((slide) => ({
        index: slide.index,
        headline: slide.headline,
        body: slide.body ?? null,
        badge: slide.badge ?? null,
      })),
      variants: variants.map((variant) => ({
        variantId: variant.id,
        channelId: variant.channelId,
        state: variant.state,
        caption: variant.caption,
        creativeRender: variant.creativeRender?.state ?? null,
      })),
      nextStep:
        "The new text is saved. Poll list_pending_content until creativeRender is rendered, then preview_content and ask the owner to approve.",
    },
  };
};
