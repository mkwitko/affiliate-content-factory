import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { directQuality, type QualityDirection } from "@money-maker/core/creatives/quality-director";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import type { Money, Offer } from "@money-maker/core/offers/offer";
import { qualitySummary } from "@money-maker/core/publishing/render-quality";
import type { FastifyInstance } from "fastify";
import type { ApiDependencies } from "../app.js";
import { sendError, unexpectedError } from "../http/errors.js";
import { getAttributionSummaryTool } from "../mcp/tools/get-attribution-summary.js";
import { getPerformanceSummaryTool } from "../mcp/tools/get-performance-summary.js";
import { getSetupStatusTool } from "../mcp/tools/get-setup-status.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
/** One variant asset for the review panel: a slide image or a Reel video (`video/mp4`). */
type Image = Readonly<{
  url: string;
  width: number | null;
  height: number | null;
  mimeType: string | null;
}>;
/**
 * What the automatic gates concluded about a variant, for the reviewer (owner brief 2026-10-08,
 * section 23.5): scene fallback reason, product fidelity, slide legibility, Reel QA warnings.
 */
export type ReviewQa = Readonly<{
  render: Readonly<{
    state: string;
    reason: string | null;
    fidelity: string | null;
    quality: string | null;
    /** Carousel sequence QA reasons (repeated scene, CTA not last...); empty when clean. */
    sequence: readonly string[];
  }> | null;
  reel: Readonly<{
    verdict: string;
    checks: readonly Readonly<{ id: string; verdict: string; detail: string | null }>[];
  }> | null;
  /** QA v2: one level per dimension and the repair each finding calls for (advisory). */
  director: QualityDirection;
}>;

export type PanelResponse = Readonly<{
  setup: unknown;
  niches: readonly {
    id: string;
    name: string;
    slug: string | null;
    state: string;
    languages: readonly string[];
  }[];
  channels: readonly {
    id: string;
    kind: string;
    label: string;
    status: string;
    nicheId: string | null;
  }[];
  offers: readonly {
    id: string;
    title: string;
    state: string;
    nicheId: string | null;
    marketplace: string | null;
    affiliateUrl: string | null;
    price: Money | null;
    listPrice: Money | null;
    verifiedAt: string | null;
    imageUrl: string | null;
  }[];
  reviewQueue: readonly {
    id: string;
    contentItemId: string;
    title: string;
    nicheId: string | null;
    channelId: string;
    channelKind: string | null;
    channelLabel: string | null;
    caption: string;
    language: string;
    state: string;
    policyMode: string | null;
    evidenceVerifiedAt: string | null;
    affiliateUrl: string | null;
    offer: { id: string; title: string; price: Money | null } | null;
    images: readonly Image[];
    qa: ReviewQa;
    /** Transparency (brief 23): each slide's plan, and whether a scene can be rejected on it. */
    slides: readonly {
      index: number;
      scene: boolean;
      storyScene: boolean;
      sceneLine: string | null;
      sceneLineSource: string | null;
      voiceLine: string | null;
      /** Earlier scenes of this slide (failed the gate or rejected by a reviewer), oldest first. */
      history: readonly {
        url: string;
        canvas: string;
        attempt: number;
        reasons: readonly string[];
      }[];
    }[];
  }[];
  variants: readonly {
    id: string;
    contentItemId: string;
    title: string;
    nicheId: string | null;
    channelId: string;
    channelKind: string | null;
    channelLabel: string | null;
    state: string;
    language: string;
    thumbnailUrl: string | null;
  }[];
  connections: readonly {
    id: string;
    provider: string;
    mode: string;
    status: string;
    accountId: string | null;
  }[];
  /** Output of get-attribution-summary with its defaults (groupBy niche, all time); null if unavailable. */
  attribution: unknown;
  /** Output of get-performance-summary with its defaults (newest 200 posts); null if unavailable. */
  performance: unknown;
}>;

const parseId = (value: string): WorkspaceId | null => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const money = (value: unknown): Money | null =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Money).amountMinor === "number" &&
  typeof (value as Money).currency === "string"
    ? (value as Money)
    : null;

/** Price facts of the offer's active snapshot; null when absent. */
const snapshotPrices = (offer: Offer) => {
  const snapshot = offer.snapshots.find((entry) => entry.id === offer.activeSnapshotId);
  const fact = (key: string) => money(snapshot?.facts.find((entry) => entry.key === key)?.value);
  return {
    price: fact("current_price"),
    listPrice: fact("list_price"),
    verifiedAt: snapshot?.verifiedAt.toISOString() ?? null,
  };
};

export const registerPanelRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.get<{ Params: { workspaceId: string } }>(
    "/v1/workspaces/:workspaceId/panel",
    async (request, reply) => {
      const deps = options.dependencies;
      const authentication = await deps.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = parseId(request.params.workspaceId);
      if (!workspaceId)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const workspace = await deps.workspaces.findByIdForMember({
        workspaceId,
        userId: authentication.userId,
      });
      if (!workspace)
        return sendError(reply, 404, {
          code: "NOT_FOUND",
          message: "Workspace not found",
        });
      const authorization = authorizeWorkspace({
        actorId: authentication.userId,
        workspaceId,
        membership: await deps.workspaces.findMembership({
          workspaceId,
          userId: authentication.userId,
        }),
        allowedRoles: ["owner", "operator", "reviewer"],
      });
      if (!authorization.ok)
        return sendError(reply, 403, {
          code: "FORBIDDEN",
          message: "Access denied",
        });
      try {
        if (
          !deps.nicheRepository?.listForWorkspace ||
          !deps.offerRepository?.listForWorkspace ||
          !deps.channelRepository?.listForWorkspace ||
          !deps.contentRepository?.listContentItemsForWorkspace ||
          !deps.providerConnections
        )
          throw new Error("Panel dependencies are not configured.");
        const content = deps.contentRepository;
        const toolArgs = { workspaceId };
        const optionalTool = async (tool: typeof getAttributionSummaryTool): Promise<unknown> => {
          try {
            const result = await tool(toolArgs, authentication.userId, deps);
            return result.ok ? result.value : null;
          } catch {
            return null;
          }
        };
        const [setup, niches, offers, channels, items, variants, connections, policy] =
          await Promise.all([
            optionalTool(getSetupStatusTool),
            deps.nicheRepository.listForWorkspace(workspaceId),
            deps.offerRepository.listForWorkspace(workspaceId),
            deps.channelRepository.listForWorkspace(workspaceId),
            content.listContentItemsForWorkspace?.(workspaceId) ?? [],
            content.listVariantsForWorkspace(workspaceId),
            deps.providerConnections.findAllForWorkspace({ workspaceId }),
            deps.publicationPolicyRepository?.findForWorkspace(workspaceId).catch(() => null) ??
              null,
          ]);
        // A draft with rendered media is the owner's to approve (the approve route submits it).
        const reviewable = variants.filter(
          (variant) =>
            variant.state === "ready_for_review" ||
            (variant.state === "draft" && variant.assetIds.length > 0),
        );
        const [attribution, performance] = await Promise.all([
          optionalTool(getAttributionSummaryTool),
          optionalTool(getPerformanceSummaryTool),
        ]);

        const imageUrl = async (assetId: string): Promise<string | null> =>
          (await deps.assetStore
            ?.createDownload({ workspaceId, assetId })
            .then((target) => target.url)
            .catch(() => null)) ?? null;
        const assetsById = new Map(
          ((await deps.assetRepository?.listForWorkspace?.(workspaceId).catch(() => [])) ?? []).map(
            (asset) => [asset.id, asset],
          ),
        );
        const images = async (assetIds: readonly string[]): Promise<Image[]> =>
          (
            await Promise.all(
              assetIds.map(async (assetId) => {
                const url = await imageUrl(assetId);
                const asset = assetsById.get(assetId);
                return url
                  ? {
                      url,
                      width: asset?.width ?? null,
                      height: asset?.height ?? null,
                      mimeType: asset?.mimeType ?? null,
                    }
                  : null;
              }),
            )
          ).filter((image): image is Image => image !== null);
        // Version compare (brief 23): the scenes a slot tried before the one on screen.
        const sceneHistory = async (contentItemId: string) => {
          const archived =
            (await deps.assetRepository
              ?.listByMetadata?.({
                workspaceId,
                role: "offer_scene",
                key: "contentItemId",
                value: contentItemId,
                state: "archived",
              })
              .catch(() => [])) ?? [];
          const strings = (value: unknown) =>
            Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
          const entries = await Promise.all(
            archived
              .filter((asset) => asset.workspaceId === workspaceId)
              .map(async (asset) => {
                const meta = asset.metadata ?? {};
                const record = (meta.ownerRejection ?? meta.inSceneFidelity) as
                  | { reasons?: unknown }
                  | undefined;
                const url = await imageUrl(asset.id);
                return url && typeof meta.slideIndex === "number"
                  ? {
                      slideIndex: meta.slideIndex,
                      url,
                      canvas: String(meta.canvas ?? "feed"),
                      attempt: typeof meta.attempt === "number" ? meta.attempt : 0,
                      reasons: strings(record?.reasons),
                    }
                  : null;
              }),
          );
          return entries.filter((entry) => entry !== null).sort((a, b) => a.attempt - b.attempt);
        };
        const reviewQa = async (variant: (typeof variants)[number]): Promise<ReviewQa> => {
          const render = variant.creativeRender;
          const first = variant.assetIds[0];
          const reel =
            first && assetsById.get(first)?.mimeType.startsWith("video/") && deps.reelRenders
              ? await deps.reelRenders
                  .findByAssetForWorkspace({ workspaceId, assetId: first })
                  .catch(() => null)
              : null;
          const summary = reel?.qualityReport ? qualitySummary(reel.qualityReport) : null;
          const renderQa = render
            ? {
                state: render.state,
                reason: render.reason ?? null,
                fidelity: render.fidelity?.verdict ?? null,
                quality: render.quality?.verdict ?? null,
                sequence: render.quality?.sequence?.reasons ?? [],
              }
            : null;
          const reelQa = summary
            ? {
                verdict: summary.verdict,
                checks: summary.checks.map((check) => ({
                  id: check.id,
                  verdict: check.verdict,
                  detail: check.detail ?? null,
                })),
              }
            : null;
          return {
            render: renderQa,
            reel: reelQa,
            director: directQuality({
              render: renderQa,
              reel: reelQa && { ...reelQa, narration: summary?.narration?.verdict ?? null },
            }),
          };
        };

        const itemsById = new Map(items.map((item) => [item.id, item]));
        const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
        const offersById = new Map(offers.map((offer) => [offer.id, offer]));
        const nicheByOffer = new Map(items.map((item) => [item.offerId, item.nicheId]));
        const variantContext = (variant: (typeof variants)[number]) => {
          const item = itemsById.get(variant.contentItemId);
          const channel = channelsById.get(variant.channelId);
          return {
            item,
            base: {
              id: variant.id,
              contentItemId: variant.contentItemId,
              title: item?.title ?? "",
              nicheId: item?.nicheId ?? null,
              channelId: variant.channelId,
              channelKind: channel?.kind ?? null,
              channelLabel: channel?.label ?? null,
              state: variant.state,
              language: variant.language,
            },
          };
        };

        return reply.code(200).send({
          setup,
          niches: niches.map((niche) => ({
            id: niche.id,
            name: niche.name,
            slug: niche.slug ?? null,
            state: niche.state,
            languages: niche.languages,
          })),
          channels: channels.map((channel) => ({
            id: channel.id,
            kind: channel.kind,
            label: channel.label,
            status: channel.status,
            nicheId: null, // channels carry no niche link in the domain model
          })),
          offers: await Promise.all(
            offers.map(async (offer) => {
              // First image of the offer's newest variant that has one; no image fact exists.
              const firstAsset = variants
                .filter((v) => itemsById.get(v.contentItemId)?.offerId === offer.id)
                .flatMap((v) => v.assetIds)[0];
              return {
                id: offer.id,
                title: offer.title,
                state: offer.state,
                nicheId: nicheByOffer.get(offer.id) ?? null,
                marketplace: offer.marketplace,
                affiliateUrl: offer.affiliateUrl ?? null,
                ...snapshotPrices(offer),
                imageUrl: firstAsset ? await imageUrl(firstAsset) : null,
              };
            }),
          ),
          reviewQueue: await Promise.all(
            reviewable.map(async (variant) => {
              const { item, base } = variantContext(variant);
              const offer = item?.offerId ? offersById.get(item.offerId) : undefined;
              return {
                ...base,
                caption: variant.caption,
                policyMode: policy?.mode ?? null,
                evidenceVerifiedAt:
                  offer?.snapshots
                    .find((entry) => entry.id === variant.offerSnapshotId)
                    ?.verifiedAt.toISOString() ?? null,
                affiliateUrl: offer?.affiliateUrl ?? null,
                offer: offer
                  ? {
                      id: offer.id,
                      title: offer.title,
                      price: snapshotPrices(offer).price,
                    }
                  : null,
                images: await images(variant.assetIds),
                qa: await reviewQa(variant),
                slides: await (async () => {
                  const history = item ? await sceneHistory(item.id) : [];
                  return (item?.creativeSlides ?? []).map((slide) => ({
                    index: slide.index,
                    scene: Boolean(slide.sceneAssetId),
                    storyScene: Boolean(slide.storySceneAssetId),
                    sceneLine: slide.sceneLine ?? null,
                    sceneLineSource: slide.sceneLineSource ?? null,
                    voiceLine: slide.voiceLine ?? null,
                    history: history
                      .filter((entry) => entry.slideIndex === slide.index)
                      .slice(-4)
                      .map(({ slideIndex: _index, ...entry }) => entry),
                  }));
                })(),
              };
            }),
          ),
          variants: await Promise.all(
            variants.map(async (variant) => {
              const first = variant.assetIds[0];
              return {
                ...variantContext(variant).base,
                thumbnailUrl: first ? await imageUrl(first) : null,
              };
            }),
          ),
          connections: connections.map(({ id, provider, mode, status, accountId }) => ({
            id,
            provider,
            mode,
            status,
            accountId,
          })),
          attribution,
          performance,
        } satisfies PanelResponse);
      } catch {
        return unexpectedError(reply);
      }
    },
  );
};
