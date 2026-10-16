import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  type ClickEvent,
  createRedirect,
  type TrackingSlug,
} from "@money-maker/core/analytics/attribution";
import type {
  AttributionRepository,
  NicheStorefront,
} from "@money-maker/core/analytics/attribution-repository";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import { registerTrackedRedirectRoutes } from "./tracked-redirect.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const trackedLinks = new Map([
  ["v-carousel", "slug-carousel"],
  ["v-old", "slug-old"],
]);

const setup = (input: {
  records?: ReturnType<typeof createRedirect>[];
  storefronts?: Record<string, NicheStorefront | null>;
  assetStore?: AssetStore;
  publicApiUrl?: string;
  webAppUrl?: string;
  failRecordClick?: boolean;
}) => {
  const records = input.records ?? [];
  const clicks: ClickEvent[] = [];
  const repository: AttributionRepository = {
    createRedirect: async (record) => record,
    findBySlug: async (slug) =>
      records.find((record) => record.slug === slug) ??
      (slug === "slug-carousel" || slug === "slug-old"
        ? createRedirect({
            workspaceId,
            destination: new URL("https://meli.la/abc"),
            expiresAt: new Date(Date.now() + 60_000),
          })
        : null),
    findForVariant: async ({ contentVariantId }) => {
      const slug = trackedLinks.get(contentVariantId);
      return slug
        ? {
            ...createRedirect({
              workspaceId,
              destination: new URL("https://meli.la/abc"),
              expiresAt: new Date(Date.now() + 60_000),
            }),
            slug: slug as TrackingSlug,
          }
        : null;
    },
    findNicheStorefront: async (slug) => input.storefronts?.[slug] ?? null,
    recordClick: async (event) => {
      if (input.failRecordClick) throw new Error("db down");
      clicks.push(event);
    },
    summary: async () => [],
  };
  const app = Fastify();
  void app.register(registerTrackedRedirectRoutes, {
    attributionRepository: repository,
    ...(input.assetStore ? { assetStore: input.assetStore } : {}),
    clickSalt: "salt",
    ...(input.publicApiUrl ? { publicApiUrl: input.publicApiUrl } : {}),
    ...(input.webAppUrl ? { webAppUrl: input.webAppUrl } : {}),
  });
  return { app, clicks };
};

const assetStore = (): AssetStore =>
  ({
    createDownload: async ({ assetId }: { assetId: string }) => ({
      method: "GET" as const,
      url: `https://r2.example/${assetId}?sig=1`,
    }),
  }) as unknown as AssetStore;

describe("tracked redirects", () => {
  it("redirects a variant link to the affiliate URL and records the click against the variant", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() + 60_000),
      contentVariantId: "v1",
    });
    const { app, clicks } = setup({ records: [record] });
    const response = await app.inject({
      url: `/go/${record.slug}`,
      headers: { "cf-connecting-ip": "1.2.3.4", referer: "https://l.instagram.com/x" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("https://meli.la/abc");
    expect(clicks).toEqual([
      {
        workspaceId,
        slug: record.slug,
        contentVariantId: "v1",
        via: "direct",
        expired: false,
        visitorHash: expect.stringMatching(/^[0-9a-f]{32}$/),
        referrerHost: "l.instagram.com",
      },
    ]);
  });

  it("records the exact publication attempt carried by a publication redirect", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() + 60_000),
      contentVariantId: "v1",
      publicationAttemptId: "attempt-1",
    });
    const { app, clicks } = setup({ records: [record] });
    const response = await app.inject({ url: `/go/${record.slug}` });
    expect(response.statusCode).toBe(302);
    expect(clicks[0]).toMatchObject({
      contentVariantId: "v1",
      publicationAttemptId: "attempt-1",
    });
  });

  it("records a bio-storefront click as bio_latest when src=bio is present", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() + 60_000),
      contentVariantId: "v1",
    });
    const { app, clicks } = setup({ records: [record] });
    const response = await app.inject({ url: `/go/${record.slug}?src=bio` });
    expect(response.statusCode).toBe(302);
    expect(clicks[0]).toMatchObject({ via: "bio_latest" });
  });

  it("sends an expired link to the listing and flags the click", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() - 1),
      fallback: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    });
    const { app, clicks } = setup({ records: [record] });
    const response = await app.inject({ url: `/go/${record.slug}` });
    expect(response.headers.location).toBe("https://www.mercadolivre.com.br/p/MLB1");
    expect(clicks[0]).toMatchObject({ expired: true });
  });

  it("answers 404 for an unknown link and 410 for an expired link without fallback", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() - 1),
    });
    const { app, clicks } = setup({ records: [record] });
    expect((await app.inject({ url: "/go/unknown" })).statusCode).toBe(404);
    expect((await app.inject({ url: `/go/${record.slug}` })).statusCode).toBe(410);
    expect(clicks).toEqual([]);
  });

  it("redirects link-preview crawlers without counting a click", async () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { app, clicks } = setup({ records: [record] });
    const response = await app.inject({
      url: `/go/${record.slug}`,
      headers: { "user-agent": "meta-externalagent/1.1" },
    });
    expect(response.statusCode).toBe(302);
    expect(clicks).toEqual([]);
  });

  describe("GET /v1/public/storefronts/:nicheSlug", () => {
    it("returns niche cards with dedupe and the official affiliate link", async () => {
      const { app } = setup({
        storefronts: {
          "tech-ab12": {
            workspaceId,
            nicheName: "Tech",
            instagramHandle: "tech.achados",
            candidates: [
              {
                offerId: "o1",
                offerTitle: "Suporte de notebook",
                affiliateUrl: "https://meli.la/abc",
                contentVariantId: "v-carousel",
                channelKind: "instagram_carousel",
                assetId: "a1",
                publishedAt: new Date("2026-09-24T00:00:00Z"),
              },
              {
                // Same offer, older Threads variant: must be deduped away by the carousel pick.
                offerId: "o1",
                offerTitle: "Suporte de notebook",
                affiliateUrl: "https://meli.la/abc",
                contentVariantId: "v-old",
                channelKind: "threads",
                assetId: "a2",
                publishedAt: new Date("2026-09-20T00:00:00Z"),
              },
            ],
          },
        },
        assetStore: assetStore(),
        publicApiUrl: "https://api.example.com",
      });
      const response = await app.inject({ url: "/v1/public/storefronts/tech-ab12" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        nicheName: "Tech",
        instagramHandle: "tech.achados",
        cards: [
          {
            offerTitle: "Suporte de notebook",
            imageUrl: "https://r2.example/a1?sig=1",
            href: "https://meli.la/abc",
            offerId: "o1",
          },
        ],
      });
    });

    it("links a card without a tracked link straight to the affiliate offer", async () => {
      const { app } = setup({
        storefronts: {
          "tech-ab12": {
            workspaceId,
            nicheName: "Tech",
            candidates: [
              {
                offerId: "o2",
                offerTitle: "Legacy offer",
                affiliateUrl: "https://meli.la/legacy",
                contentVariantId: "v-without-link",
                channelKind: "instagram_carousel",
                assetId: "a3",
                publishedAt: new Date("2026-09-24T00:00:00Z"),
              },
            ],
          },
        },
        assetStore: assetStore(),
        publicApiUrl: "https://api.example.com",
      });
      const response = await app.inject({ url: "/v1/public/storefronts/tech-ab12" });
      expect(response.statusCode).toBe(200);
      expect(response.json().cards).toEqual([
        expect.objectContaining({ href: "https://meli.la/legacy", offerId: "o2" }),
      ]);
    });

    it("prices a card only from an active snapshot verified within 24 hours", async () => {
      const freshAt = new Date(Date.now() - 60 * 60 * 1000);
      const base = {
        affiliateUrl: "https://meli.la/abc",
        channelKind: "instagram_carousel" as const,
        publishedAt: new Date("2026-09-24T00:00:00Z"),
      };
      const { app } = setup({
        storefronts: {
          "tech-ab12": {
            workspaceId,
            nicheName: "Example Shop Tech",
            candidates: [
              {
                ...base,
                offerId: "o-fresh",
                offerTitle: "Fresh",
                contentVariantId: "v-fresh",
                assetId: "a1",
                activeSnapshot: {
                  verifiedAt: freshAt,
                  currentPrice: { amountMinor: 12990, currency: "BRL" },
                  listPrice: { amountMinor: 15990, currency: "BRL" },
                },
              },
              {
                ...base,
                offerId: "o-stale",
                offerTitle: "Stale",
                contentVariantId: "v-stale",
                assetId: "a2",
                activeSnapshot: {
                  verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
                  currentPrice: { amountMinor: 9990, currency: "BRL" },
                },
              },
            ],
          },
        },
        assetStore: assetStore(),
      });
      const response = await app.inject({ url: "/v1/public/storefronts/tech-ab12" });
      const [fresh, stale] = response.json().cards;
      expect(fresh).toEqual({
        offerTitle: "Fresh",
        imageUrl: "https://r2.example/a1?sig=1",
        href: "https://meli.la/abc",
        offerId: "o-fresh",
        price: { amountMinor: 12990, currency: "BRL" },
        listPrice: { amountMinor: 15990, currency: "BRL" },
        priceVerifiedAt: freshAt.toISOString(),
      });
      expect(stale).toEqual({
        offerTitle: "Stale",
        imageUrl: "https://r2.example/a2?sig=1",
        href: "https://meli.la/abc",
        offerId: "o-stale",
      });
    });

    it("returns null instagramHandle and empty cards for a known niche with no offers", async () => {
      const { app } = setup({
        storefronts: { "tech-ab12": { workspaceId, nicheName: "Tech", candidates: [] } },
      });
      const response = await app.inject({ url: "/v1/public/storefronts/tech-ab12" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ nicheName: "Tech", instagramHandle: null, cards: [] });
    });

    it("answers 404 JSON for an unknown niche slug", async () => {
      const { app } = setup({ storefronts: {} });
      const response = await app.inject({ url: "/v1/public/storefronts/unknown" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    });
  });

  describe("POST /v1/public/clicks", () => {
    const storefronts = {
      tech: {
        workspaceId,
        nicheName: "Tech",
        candidates: [
          {
            offerId: "offer-1",
            offerTitle: "Lamp",
            affiliateUrl: "https://meli.la/abc",
            contentVariantId: "variant-1",
            channelKind: "threads" as const,
            assetId: "asset-1",
            publishedAt: new Date(),
          },
        ],
      },
    };

    it("records a storefront click against its published variant without redirecting", async () => {
      const { app, clicks } = setup({ storefronts });
      const response = await app.inject({
        method: "POST",
        url: "/v1/public/clicks",
        payload: { nicheSlug: "tech", offerId: "offer-1" },
        headers: { "user-agent": "Mozilla/5.0", referer: "https://shop.example/tech" },
      });

      expect(response.statusCode).toBe(204);
      expect(response.headers.location).toBeUndefined();
      expect(clicks[0]).toMatchObject({
        workspaceId,
        contentVariantId: "variant-1",
        via: "storefront",
        expired: false,
        referrerHost: "shop.example",
      });
    });

    it("ignores bot clicks and repository failures", async () => {
      const { app, clicks } = setup({ storefronts, failRecordClick: true });
      const payload = { nicheSlug: "tech", offerId: "offer-1" };
      const bot = await app.inject({
        method: "POST",
        url: "/v1/public/clicks",
        payload,
        headers: { "user-agent": "Googlebot" },
      });
      const failed = await app.inject({ method: "POST", url: "/v1/public/clicks", payload });

      expect(bot.statusCode).toBe(204);
      expect(failed.statusCode).toBe(204);
      expect(clicks).toEqual([]);
    });
  });

  describe("GET /go/n/:nicheSlug", () => {
    it("redirects a known niche to the web app's short storefront URL", async () => {
      const { app } = setup({
        storefronts: { "tech-ab12": { workspaceId, nicheName: "Tech", candidates: [] } },
        webAppUrl: "https://app.example.com",
      });
      const response = await app.inject({ url: "/go/n/tech-ab12" });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://app.example.com/tech-ab12");
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("answers 404 for an unknown niche slug", async () => {
      const { app } = setup({ storefronts: {}, webAppUrl: "https://app.example.com" });
      const response = await app.inject({ url: "/go/n/unknown" });
      expect(response.statusCode).toBe(404);
    });

    it("answers 404 when the web app URL is not configured", async () => {
      const { app } = setup({
        storefronts: { "tech-ab12": { workspaceId, nicheName: "Tech", candidates: [] } },
      });
      const response = await app.inject({ url: "/go/n/tech-ab12" });
      expect(response.statusCode).toBe(404);
    });
  });
});
