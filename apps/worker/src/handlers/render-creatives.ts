import type { WorkspaceId } from "@money-maker/contracts";
import type { ChannelKind } from "@money-maker/core/channels/channel";
import type { ContentVariant } from "@money-maker/core/content/content";
import { RENDERER_VERSION } from "@money-maker/core/creatives/creative-renderer";
import type {
  RenderCreativesDeps,
  RenderCreativesOutcome,
} from "@money-maker/core/creatives/render-creatives";
import { renderCreatives } from "@money-maker/core/creatives/render-creatives";
import type { JobIdentifierPayload } from "@money-maker/core/jobs/job";
import { PermanentJobError } from "@money-maker/core/jobs/job";

type RenderCreativesJob = Readonly<{ payload: JobIdentifierPayload }>;

const canvasForChannel = (kind: ChannelKind): "feed" | "story" =>
  kind === "instagram_stories" || kind === "tiktok_photo_post" ? "story" : "feed";

/**
 * Video-only channel kinds: their asset is a rendered reel or an owned clip (created later by
 * create_content_variant), never a slide image, so this slide-rendering job skips them cleanly.
 */
const videoOnlyChannelKinds: ReadonlySet<ChannelKind> = new Set([
  "instagram_reels",
  "tiktok_video",
]);

const failedState = (reason: string): NonNullable<ContentVariant["creativeRender"]> => ({
  state: "failed",
  reason,
  templateVersions: {},
  rendererVersion: RENDERER_VERSION,
  brandKitHash: "",
});

export const assertRendererReady = async (input: {
  assertFontsPresent: () => void;
  renderSelfCheck: () => Promise<Uint8Array>;
  verifyOutput: (bytes: Uint8Array) => Promise<boolean>;
}): Promise<void> => {
  input.assertFontsPresent();
  if (!(await input.verifyOutput(await input.renderSelfCheck())))
    throw new Error("renderer_self_check_failed");
};

export const createRenderCreativesHandler =
  (
    dependencies: RenderCreativesDeps,
    /** Runs after a successful render (auto packages queue their Reels); never fails the job. */
    afterRendered?: (input: {
      workspaceId: WorkspaceId;
      contentItemId: string;
    }) => Promise<unknown>,
  ) =>
  async (job: RenderCreativesJob): Promise<void> => {
    const workspaceId = job.payload.workspaceId;
    const contentItemId = job.payload.identifiers.contentItemId;
    if (!contentItemId) throw new PermanentJobError("creative_content_item_id_missing");
    const item = await dependencies.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId,
    });
    if (!item) throw new PermanentJobError("content_not_found");
    const variants = (await dependencies.content.listVariantsForWorkspace(workspaceId)).filter(
      (variant) => variant.contentItemId === item.id,
    );
    const failVariants = async (reason: string): Promise<void> => {
      await Promise.all(
        variants.map((variant) =>
          dependencies.content.updateVariant({ ...variant, creativeRender: failedState(reason) }),
        ),
      );
    };
    if (!item.creativeSlides || item.creativeSlides.length === 0) {
      await failVariants("creative_slides_missing");
      throw new PermanentJobError("creative_slides_missing");
    }
    const channels: Array<{ channelId: string; kind: ChannelKind; canvas: "feed" | "story" }> = [];
    for (const variant of variants) {
      const channel = await dependencies.channels.findForWorkspace({
        workspaceId,
        channelId: variant.channelId,
      });
      if (!channel) {
        await failVariants("channel_not_found");
        throw new PermanentJobError("channel_not_found");
      }
      if (videoOnlyChannelKinds.has(channel.kind)) continue;
      channels.push({
        channelId: channel.id,
        kind: channel.kind,
        canvas: canvasForChannel(channel.kind),
      });
    }
    const result: RenderCreativesOutcome = await renderCreatives(dependencies, {
      workspaceId,
      contentItemId,
      slides: item.creativeSlides,
      channels,
    });
    if (result.status !== "rendered") {
      await failVariants(result.reason);
      throw new PermanentJobError(result.reason);
    }
    for (const fallback of result.fallbacks)
      console.warn("fallback_used", { workspaceId, contentItemId, fallback });
    await afterRendered?.({ workspaceId, contentItemId }).catch((error: unknown) =>
      console.warn("after_render_failed", {
        workspaceId,
        contentItemId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  };
