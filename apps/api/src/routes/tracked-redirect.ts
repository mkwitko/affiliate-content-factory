import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AttributionRepository,
  NicheStorefront,
} from "@money-maker/core/analytics/attribution-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import {
  buildNicheStorefront,
  type StorefrontCard,
} from "@money-maker/core/analytics/bio-storefront";
import {
  type ClickEvent,
  resolveTrackedRedirect,
  type TrackingSlug,
  visitorHash,
} from "@money-maker/core/analytics/attribution";
import type { Money } from "@money-maker/core/offers/offer";
import { sendError } from "../http/errors.js";

type PublicStorefrontCard = Readonly<{
  offerId: string;
  offerTitle: string;
  imageUrl: string;
  href: string;
  price?: Money;
  listPrice?: Money;
  priceVerifiedAt?: string;
}>;

/** Card assembly shared by nothing else: the only public consumer is the JSON storefront route. */
const buildStorefrontCards = async (
  storefront: NicheStorefront,
  options: { assetStore?: AssetStore },
): Promise<PublicStorefrontCard[]> => {
  const picks = buildNicheStorefront(storefront.candidates);
  const cards = await Promise.all(
    picks.map(async (pick: StorefrontCard) => {
      const imageUrl = await options.assetStore
        ?.createDownload({ workspaceId: storefront.workspaceId, assetId: pick.assetId })
        .then((target) => target.url)
        .catch(() => null);
      if (!imageUrl) return null;
      const card: PublicStorefrontCard = {
        offerId: pick.offerId,
        offerTitle: pick.offerTitle,
        imageUrl,
        href: pick.affiliateUrl,
      };
      if (!pick.price) return card;
      return {
        ...card,
        price: pick.price.current,
        ...(pick.price.list ? { listPrice: pick.price.list } : {}),
        priceVerifiedAt: pick.price.verifiedAt.toISOString(),
      };
    }),
  );
  return cards.filter((card): card is NonNullable<typeof card> => card !== null);
};

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;

/** Cloudflare fronts the API and sets this header; X-Forwarded-For is spoofable, so it is not read. */
const clientIp = (request: FastifyRequest): string =>
  firstHeader(request.headers["cf-connecting-ip"]) ?? request.ip;

// Link-preview crawlers fetch every link posted on Threads or shared in chats; they are not buyers.
const crawler =
  /facebookexternalhit|meta-externalagent|facebookcatalog|whatsapp|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|googlebot|bingbot|bot\b|crawler|spider|preview/i;

const referrerHost = (request: FastifyRequest): string | undefined => {
  try {
    return new URL(request.headers.referer ?? "").hostname || undefined;
  } catch {
    return undefined;
  }
};

// ponytail: no per-IP rate limit here; Cloudflare fronts the API. Add @fastify/rate-limit if
// click spam ever shows up in click_events.
export const registerTrackedRedirectRoutes = async (
  app: FastifyInstance,
  options: {
    attributionRepository?: AttributionRepository;
    assetStore?: AssetStore;
    clickSalt?: string;
    publicApiUrl?: string;
    webAppUrl?: string;
  },
): Promise<void> => {
  const repository = options.attributionRepository;
  const click = (
    request: FastifyRequest,
    event: Omit<ClickEvent, "visitorHash" | "referrerHost">,
  ) => {
    if (crawler.test(request.headers["user-agent"] ?? "")) return undefined;
    const referrer = referrerHost(request);
    return repository
      ?.recordClick({
        ...event,
        visitorHash: visitorHash({
          salt: options.clickSalt ?? "",
          ip: clientIp(request),
          userAgent: request.headers["user-agent"] ?? "",
        }),
        ...(referrer ? { referrerHost: referrer } : {}),
      })
      .catch((error: unknown) => request.log.error({ err: error }, "click not recorded"));
  };

  app.get<{ Params: { slug: string }; Querystring: { src?: string } }>(
    "/go/:slug",
    async (request, reply) => {
      if (!repository) return reply.code(404).send();
      const record = await repository.findBySlug(request.params.slug as TrackingSlug);
      if (!record) return reply.code(404).send();
      let resolved: ReturnType<typeof resolveTrackedRedirect>;
      try {
        resolved = resolveTrackedRedirect(record);
      } catch {
        return reply.code(410).send();
      }
      // A lost click must never block the buyer on the way to the offer.
      await click(request, {
        workspaceId: record.workspaceId,
        slug: record.slug,
        ...(record.contentVariantId ? { contentVariantId: record.contentVariantId } : {}),
        ...(record.publicationAttemptId
          ? { publicationAttemptId: record.publicationAttemptId }
          : {}),
        via: request.query.src === "bio" ? "bio_latest" : "direct",
        expired: resolved.expired,
      });
      return reply.header("cache-control", "no-store").redirect(resolved.url.toString());
    },
  );

  // Bio link already pasted on Instagram; keep it alive by handing off to the web app's short URL.
  app.get<{ Params: { nicheSlug: string } }>("/go/n/:nicheSlug", async (request, reply) => {
    if (!repository || !options.webAppUrl) return reply.code(404).send();
    const storefront = await repository.findNicheStorefront(request.params.nicheSlug);
    if (!storefront) return reply.code(404).send();
    return reply
      .header("cache-control", "no-store")
      .redirect(
        new URL(`/${encodeURIComponent(request.params.nicheSlug)}`, options.webAppUrl).toString(),
      );
  });

  app.post<{ Body: { nicheSlug?: string; offerId?: string } }>(
    "/v1/public/clicks",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { nicheSlug, offerId } = request.body ?? {};
      if (!repository || typeof nicheSlug !== "string" || typeof offerId !== "string") {
        return reply.code(204).send();
      }
      const storefront = await repository.findNicheStorefront(nicheSlug).catch(() => null);
      const candidate = storefront?.candidates.find((item) => item.offerId === offerId);
      if (!storefront || !candidate) return reply.code(204).send();
      await click(request, {
        workspaceId: storefront.workspaceId,
        contentVariantId: candidate.contentVariantId,
        via: "storefront",
        expired: false,
      });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { nicheSlug: string } }>(
    "/v1/public/storefronts/:nicheSlug",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!repository)
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Storefront not found" });
      const storefront = await repository.findNicheStorefront(request.params.nicheSlug);
      if (!storefront)
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Storefront not found" });
      const cards = await buildStorefrontCards(storefront, {
        ...(options.assetStore ? { assetStore: options.assetStore } : {}),
      });
      return reply.send({
        nicheName: storefront.nicheName,
        instagramHandle: storefront.instagramHandle ?? null,
        cards,
      });
    },
  );
};
