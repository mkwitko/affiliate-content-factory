import { computeAllLearnings, platformOf } from "@money-maker/core/analytics/learnings";
import { recommendFormat } from "@money-maker/core/content/format-director";
import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import { buildNicheResearchContext } from "@money-maker/core/research/niche-context";
import { mergeEditorialContext } from "@money-maker/core/context/merge-editorial-context";
import type { McpDependencies, ToolResult } from "../server.js";
import { publicAssetUrl } from "./import-asset-from-url.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getGenerationContextInputSchema = z
  .object({
    workspaceId: z.uuid(),
    nicheId: z.string().trim().min(1).max(200),
    channelId: z.string().trim().min(1).max(200),
    contentItemId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "The content item being made; seeds the format recommendation so a retry repeats it.",
      ),
  })
  .strict();

// tiktokShop is operator-status data, not creative editorial context; keep it out of generation.
const stripTikTokShop = (
  context: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!context || !("tiktokShop" in context)) return context ?? null;
  const { tiktokShop: _tiktokShop, ...rest } = context;
  return rest;
};

export const getGenerationContextTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getGenerationContextInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  if (!deps.nicheRepository || !deps.channelRepository)
    throw new Error("Niche and channel repositories are not configured.");
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;

  const [niche, channel] = await Promise.all([
    deps.nicheRepository.findForWorkspace({ workspaceId, nicheId: parsed.data.nicheId }),
    deps.channelRepository.findForWorkspace({ workspaceId, channelId: parsed.data.channelId }),
  ]);
  if (!niche || !channel) return { ok: false, error: "NOT_FOUND" };

  const getContext = deps.workspaces.getContext;
  const brand = getContext ? await getContext.call(deps.workspaces, workspaceId) : null;

  const research = deps.researchRepository;
  const findActiveForNiche = research?.findActiveForNiche;
  const snapshots = findActiveForNiche
    ? await findActiveForNiche.call(research, { workspaceId, nicheId: niche.id, now: new Date() })
    : [];

  const history = deps.productPostingHistoryRepository
    ? await deps.productPostingHistoryRepository.productPostingHistory({
        workspaceId,
        nicheId: niche.id,
      })
    : [];
  // Newest first, so the operator sees what to avoid before choosing a product.
  const recentProducts = history.slice(0, 20).map((entry) => ({
    title: entry.offerTitle,
    productId: entry.productId,
    lastPostedAt: entry.lastPublishedAt.toISOString(),
    channels: entry.channels,
  }));

  // Story cast with a stable link per reference sheet, so every generation can attach the
  // same character images.
  const cast = Array.isArray(niche.context?.characters) ? niche.context.characters : [];
  const characters = cast.map((character: Record<string, unknown>) => {
    const ids = Array.isArray(character.referenceAssetIds) ? character.referenceAssetIds : [];
    return {
      ...character,
      referenceUrls: ids.flatMap((id: unknown) => {
        const url =
          typeof id === "string" ? publicAssetUrl(deps.publicApiUrl, workspaceId, id) : undefined;
        return url ? [url] : [];
      }),
    };
  });

  // Format director (spec 3.4): recommends only; approval and policy stay the authority.
  const policy = await deps.publicationPolicyRepository?.findForWorkspace(workspaceId);
  const observations =
    (await deps.performanceRepository?.observationsAtCheckpoint(workspaceId, {
      checkpointDays: 7,
    })) ?? [];
  const learnings = computeAllLearnings(observations, {
    checkpointDays: 7,
    platform: platformOf(channel.kind),
  });
  const recentFormats = [];
  for (const variant of (await deps.contentRepository?.listVariantsForWorkspace(workspaceId, {
    states: ["approved", "published"],
    limit: 20,
  })) ?? []) {
    if (recentFormats.length === 3) break;
    const item = await deps.contentRepository?.findContentItemForWorkspace({
      workspaceId,
      contentItemId: variant.contentItemId,
    });
    if (item?.nicheId !== niche.id) continue;
    recentFormats.push({
      format: variant.creativeFeatures?.format,
      hookMove: variant.creativeFeatures?.hookMove,
    });
  }
  const item = parsed.data.contentItemId
    ? await deps.contentRepository?.findContentItemForWorkspace({
        workspaceId,
        contentItemId: parsed.data.contentItemId,
      })
    : null;
  const ownedLongForms =
    (await deps.longFormRenderRepository?.listRecentForWorkspace({
      workspaceId,
      limit: 1,
    })) ?? [];
  const experiments = niche.context?.experiments;
  const experimentSettings =
    typeof experiments === "object" && experiments !== null
      ? (experiments as { explorationRate?: unknown; allowTrialRenderers?: unknown })
      : {};
  const rate = experimentSettings.explorationRate;
  // Without an item id the seed follows the niche's content items, so it moves with every new one.
  const nicheItems = parsed.data.contentItemId
    ? []
    : ((await deps.contentRepository?.listContentItemsForWorkspace?.(workspaceId)) ?? []).filter(
        (entry) => entry.nicheId === niche.id,
      );
  const recommendation = recommendFormat({
    seed:
      parsed.data.contentItemId ??
      `${niche.id}:${channel.id}:${nicheItems.length}:${nicheItems[0]?.id ?? ""}`,
    nicheId: niche.id,
    topic: item?.offerId ?? `niche:${niche.id}`,
    nicheKind: niche.kind,
    channelKinds: [channel.kind],
    // ponytail: without an item the photo is assumed imported with the offer; an item with no
    // source pictures cannot use product formats.
    hasProductPhoto: item ? (item.sourcePictureAssetIds?.length ?? 0) > 0 : true,
    hasOwnedLongFormSource: ownedLongForms.some((entry) => entry.render.status === "ready"),
    allowedFormats: policy?.allowedFormats,
    learnings,
    recentFormats,
    explorationRate: typeof rate === "number" && rate >= 0 && rate <= 1 ? rate : undefined,
    allowTrialRenderers: experimentSettings.allowTrialRenderers === true,
  });
  return {
    ok: true,
    value: {
      recommendation,
      brand: brand ?? null,
      niche: niche.context ?? null,
      channel: stripTikTokShop(channel.context),
      research: buildNicheResearchContext(snapshots),
      merged: mergeEditorialContext([brand, niche.context, stripTikTokShop(channel.context)]),
      recentProducts,
      characters,
    },
  };
};
