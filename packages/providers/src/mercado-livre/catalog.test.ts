import { describe, expect, it } from "vitest";
import { MercadoLivreCatalog } from "./catalog.js";

const response = (status: number, body: unknown) => ({
  status,
  json: async () => body,
});
/** Routes a mocked client by path: /products/search vs. /products/{id} vs. /items/{id}. */
const routedClient = (
  routes: Record<string, { status: number; json: () => Promise<unknown> }>,
) => ({
  request: async (path: string) => {
    for (const [prefix, res] of Object.entries(routes)) if (path.startsWith(prefix)) return res;
    throw new Error(`unmocked path: ${path}`);
  },
});
const buyBoxProduct = (overrides: Record<string, unknown> = {}) => ({
  name: "Cafeteira",
  permalink: "https://www.mercadolivre.com.br/p/MLB100",
  status: "active",
  buy_box_winner: {
    item_id: "MLB123",
    price: 99.9,
    currency_id: "BRL",
    available_quantity: 5,
    seller_id: 456,
    ...overrides,
  },
});
describe("Mercado Livre catalog search (catalog API)", () => {
  it("maps a product's buy box winner to a candidate", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB100" }] }),
        "/products/MLB100": response(200, buyBoxProduct()),
      }),
    );
    await expect(catalog.search({ query: "cafeteira", limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        providerId: "MLB100",
        title: "Cafeteira",
        seller: "seller:456",
        listingUrl: expect.any(URL),
        currentPrice: { amountMinor: 9990, currency: "BRL" },
      }),
    ]);
    await expect(catalog.search({ query: "x", limit: 101 })).rejects.toThrow("invalid_limit");
  });
  it("carries the product's domain so research can drop books", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB100" }] }),
        "/products/MLB100": response(200, { ...buyBoxProduct(), domain_id: "MLB-BOOKS" }),
      }),
    );
    const [found] = await catalog.search({ query: "organizador", limit: 10 });
    expect(found?.domainId).toBe("MLB-BOOKS");
    const branded = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB100" }] }),
        "/products/MLB100": response(200, {
          ...buyBoxProduct(),
          attributes: [{ id: "BRAND", value_name: " Amazon " }],
        }),
      }),
    );
    expect((await branded.search({ query: "echo", limit: 10 }))[0]?.brand).toBe("Amazon");
  });

  it("reads the best sellers of the category a query points to, keeping their position", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/sites/MLB/domain_discovery/search": response(200, [{ category_id: "MLB277563" }]),
        "/highlights/MLB/category/MLB277563": response(200, {
          content: [
            { id: "MLB9", position: 1, type: "ITEM" },
            { id: "MLB100", position: 2, type: "PRODUCT" },
          ],
        }),
        "/products/MLB100": response(200, buyBoxProduct()),
      }),
    );
    await expect(catalog.searchBestSellers({ query: "organizador", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ providerId: "MLB100", bestSellerRank: 2 }),
    ]);
  });

  it("returns no best sellers when the query maps to no category, and maps a refusal", async () => {
    const empty = new MercadoLivreCatalog(
      routedClient({ "/sites/MLB/domain_discovery/search": response(200, []) }),
    );
    await expect(empty.searchBestSellers({ query: "x", limit: 5 })).resolves.toEqual([]);
    const refused = new MercadoLivreCatalog(
      routedClient({
        "/sites/MLB/domain_discovery/search": response(200, [{ category_id: "MLB1" }]),
        "/highlights/MLB/category/MLB1": response(403, { message: "forbidden" }),
      }),
    );
    await expect(refused.searchBestSellers({ query: "x", limit: 5 })).rejects.toThrow(
      "unauthorized",
    );
  });

  it("uses the seller nickname when the buy box winner has one", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB100" }] }),
        "/products/MLB100": response(200, buyBoxProduct({ seller: { nickname: "Loja Oficial" } })),
      }),
    );
    await expect(catalog.search({ query: "cafeteira", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ seller: "Loja Oficial" }),
    ]);
  });
  it("falls back to the product's first active offer when there is no buy box winner", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB26034306" }] }),
        "/products/MLB26034306/items": response(200, {
          results: [
            {
              item_id: "MLB555",
              price: 349.9,
              currency_id: "BRL",
              seller_id: 77,
            },
          ],
        }),
        "/products/MLB26034306": response(200, {
          name: "Air Fryer 4L",
          permalink: "https://www.mercadolivre.com.br/p/MLB26034306",
          buy_box_winner: null,
        }),
      }),
    );
    await expect(catalog.search({ query: "air fryer", limit: 3 })).resolves.toEqual([
      expect.objectContaining({
        providerId: "MLB26034306",
        title: "Air Fryer 4L",
        seller: "seller:77",
        currentPrice: { amountMinor: 34990, currency: "BRL" },
      }),
    ]);
  });

  it("skips a product with no buy box winner and no active offers, keeping the rest", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, {
          results: [{ id: "MLB1" }, { id: "MLB2" }],
        }),
        "/products/MLB1/items": response(404, {
          message: "No winners found",
          error: "not_found",
          status: 404,
        }),
        "/products/MLB1": response(200, {
          name: "Sem oferta",
          buy_box_winner: null,
        }),
        "/products/MLB2": response(200, buyBoxProduct()),
      }),
    );
    await expect(catalog.search({ query: "cafeteira", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ providerId: "MLB2" }),
    ]);
  });
  it("skips a product with zero stock or missing buy box fields", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, {
          results: [{ id: "MLB1" }, { id: "MLB2" }, { id: "MLB3" }],
        }),
        "/products/MLB1": response(200, buyBoxProduct({ available_quantity: 0 })),
        "/products/MLB2": response(200, {
          name: "Sem vendedor",
          permalink: "https://www.mercadolivre.com.br/p/MLB2",
          buy_box_winner: { item_id: "MLB2X", price: 10, currency_id: "BRL" },
        }),
        "/products/MLB3": response(200, buyBoxProduct()),
      }),
    );
    await expect(catalog.search({ query: "cafeteira", limit: 10 })).resolves.toEqual([
      expect.objectContaining({ providerId: "MLB3" }),
    ]);
  });
  it("falls back to a mercadolivre.com.br permalink when the product has none", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, { results: [{ id: "MLB100" }] }),
        "/products/MLB100": response(200, {
          name: "Cafeteira",
          buy_box_winner: buyBoxProduct().buy_box_winner,
        }),
      }),
    );
    const [item] = await catalog.search({ query: "cafeteira", limit: 10 });
    expect(item?.listingUrl.toString()).toBe("https://www.mercadolivre.com.br/p/MLB100");
  });
  it("maps a 403 on products/search to unauthorized, keeping status and body", async () => {
    const catalog = new MercadoLivreCatalog({
      request: async () =>
        response(403, {
          message: "forbidden",
          error: "forbidden",
          status: 403,
        }),
    });
    await expect(catalog.search({ query: "x", limit: 1 })).rejects.toMatchObject({
      message: "unauthorized",
      status: 403,
      providerError: expect.stringContaining("forbidden"),
    });
  });
  it("maps a 429 on products/search to rate_limited", async () => {
    const catalog = new MercadoLivreCatalog({
      request: async () => response(429, {}),
    });
    await expect(catalog.search({ query: "x", limit: 1 })).rejects.toThrow("rate_limited");
  });
  it("stops the whole search when a product detail call is rate limited", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/search": response(200, {
          results: [{ id: "MLB1" }, { id: "MLB2" }],
        }),
        "/products/MLB1": response(429, {}),
      }),
    );
    await expect(catalog.search({ query: "x", limit: 10 })).rejects.toMatchObject({
      message: "rate_limited",
      status: 429,
    });
  });
  it("caps product detail calls at the requested limit", async () => {
    const calls: string[] = [];
    const results = Array.from({ length: 5 }, (_, i) => ({ id: `MLB${i}` }));
    const catalog = new MercadoLivreCatalog({
      request: async (path: string) => {
        calls.push(path);
        if (path.startsWith("/products/search")) return response(200, { results });
        return response(200, buyBoxProduct());
      },
    });
    const items = await catalog.search({ query: "x", limit: 2 });
    expect(items).toHaveLength(2);
    expect(calls.filter((p) => p.startsWith("/products/MLB"))).toHaveLength(2);
  });
});
describe("Mercado Livre catalog readProductEvidence (catalog product)", () => {
  it("maps the product listing status into commercial evidence", async () => {
    for (const status of ["active", "paused", "closed", "unknown"] as const) {
      const catalog = new MercadoLivreCatalog(
        routedClient({
          "/reviews/item/MLB123": response(403, { error: "access_denied" }),
          "/products/MLB100": response(200, { ...buyBoxProduct(), status }),
        }),
      );
      await expect(catalog.readProductEvidence("MLB100")).resolves.toMatchObject({
        listingStatus: status,
      });
    }
  });

  it("reads evidence from the catalog product and its offer, never /items", async () => {
    const paths: string[] = [];
    const catalog = new MercadoLivreCatalog({
      request: async (path: string) => {
        paths.push(path);
        if (path.startsWith("/products/MLB100")) return response(200, buyBoxProduct());
        return response(403, { error: "access_denied" });
      },
    });
    await expect(catalog.readProductEvidence("MLB100")).resolves.toEqual(
      expect.objectContaining({
        providerId: "MLB100",
        currentPrice: { amountMinor: 9990, currency: "BRL" },
        observedAt: expect.any(Date),
      }),
    );
    expect(paths.some((path) => path.startsWith("/items"))).toBe(false);
  });
  it("falls back to the plain item reviews read when the catalog-scoped one is refused", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/reviews/item/MLB123?catalog_product_id": response(403, { error: "forbidden" }),
        "/reviews/item/MLB123?limit": response(200, { rating_average: 4.6, paging: { total: 80 } }),
        "/products/MLB100": response(200, buyBoxProduct()),
      }),
    );
    await expect(catalog.readProductEvidence("MLB100")).resolves.toMatchObject({
      ratingAverage: 4.6,
      reviewCount: 80,
    });
  });
  it("maps list price, sold and available quantity, free shipping, and the review summary", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/reviews/item/MLB123": response(200, {
          rating_average: 4.8,
          paging: { total: 9231 },
        }),
        "/products/MLB100": response(
          200,
          buyBoxProduct({
            original_price: 139.9,
            sold_quantity: 12000,
            available_quantity: 7,
            shipping: { free_shipping: true },
          }),
        ),
      }),
    );
    await expect(catalog.readProductEvidence("MLB100")).resolves.toEqual(
      expect.objectContaining({
        listPrice: { amountMinor: 13990, currency: "BRL" },
        soldQuantity: 12000,
        availableQuantity: 7,
        freeShipping: true,
        ratingAverage: 4.8,
        reviewCount: 9231,
      }),
    );
  });
  it("omits optional commercial fields Mercado Livre does not return or that are not real", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/reviews/item/MLB123": response(403, { error: "access_denied" }),
        "/products/MLB100": response(
          200,
          buyBoxProduct({
            original_price: 99.9,
            available_quantity: undefined,
          }),
        ),
      }),
    );
    const evidence = await catalog.readProductEvidence("MLB100");
    for (const key of [
      "listPrice",
      "soldQuantity",
      "availableQuantity",
      "freeShipping",
      "ratingAverage",
      "reviewCount",
    ])
      expect(evidence).not.toHaveProperty(key);
  });
  it("rejects a product without an active offer", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/MLB1/items": response(404, { error: "not_found" }),
        "/products/MLB1": response(200, {
          name: "Sem oferta",
          buy_box_winner: null,
        }),
      }),
    );
    await expect(catalog.readProductEvidence("MLB1")).rejects.toThrow("no_active_offer");
  });
});
describe("Mercado Livre catalog readBuyerVoice", () => {
  it("splits reviews by rating and returns answered and open questions", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/MLB100": response(200, {
          ...buyBoxProduct(),
          pictures: [
            {
              url: "https://http2.mlstatic.com/D_1-F.jpg",
              max_width: 1200,
              max_height: 900,
            },
            {
              url: "http://insecure.example/2.jpg",
              max_width: 10,
              max_height: 10,
            },
            { url: "https://http2.mlstatic.com/D_3-F.jpg" },
          ],
        }),
        "/reviews/item/MLB123": response(200, {
          rating_average: 4.2,
          paging: { total: 3 },
          reviews: [
            {
              rate: 5,
              title: "Firme",
              content: "  Aguenta   meu notebook de 15\n",
            },
            { rate: 1, title: "Balança", content: "Balança quando digito" },
            { rate: 3, title: "Ok", content: "Mediano" },
          ],
        }),
        "/questions/search?item=MLB123": response(200, {
          questions: [
            { text: "Cabe 17?", answer: { text: "Sim" } },
            { text: "Dobra?", answer: null },
          ],
        }),
      }),
    );
    await expect(catalog.readBuyerVoice("MLB100")).resolves.toEqual(
      expect.objectContaining({
        ratingAverage: 4.2,
        reviewCount: 3,
        positiveReviews: [{ rating: 5, title: "Firme", text: "Aguenta meu notebook de 15" }],
        negativeReviews: [{ rating: 1, title: "Balança", text: "Balança quando digito" }],
        questions: [
          { question: "Cabe 17?", answer: "Sim" },
          { question: "Dobra?", answer: null },
        ],
        pictures: [
          {
            url: "https://http2.mlstatic.com/D_1-F.jpg",
            width: 1200,
            height: 900,
            position: 0,
          },
          {
            url: "https://http2.mlstatic.com/D_3-F.jpg",
            width: null,
            height: null,
            position: 1,
          },
        ],
        unavailable: [],
      }),
    );
  });
  it("reports endpoints the app may not read instead of failing", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/MLB100": response(200, buyBoxProduct()),
        "/reviews/item/MLB123": response(403, { error: "access_denied" }),
        "/questions/search": response(403, { error: "access_denied" }),
      }),
    );
    await expect(catalog.readBuyerVoice("MLB100")).resolves.toEqual(
      expect.objectContaining({
        ratingAverage: null,
        positiveReviews: [],
        questions: [],
        unavailable: ["reviews", "questions"],
      }),
    );
  });
  it("surfaces rate limiting", async () => {
    const catalog = new MercadoLivreCatalog(
      routedClient({
        "/products/MLB100": response(200, buyBoxProduct()),
        "/reviews/item/MLB123": response(429, {}),
        "/questions/search": response(200, { questions: [] }),
      }),
    );
    await expect(catalog.readBuyerVoice("MLB100")).rejects.toThrow("rate_limited");
  });
});
describe("Mercado Livre trends", () => {
  it("reads a category's trending searches and drops malformed entries", async () => {
    const paths: string[] = [];
    const catalog = new MercadoLivreCatalog({
      request: async (path: string) => {
        paths.push(path);
        return response(200, [
          {
            keyword: "fone bluetooth",
            url: "https://lista.mercadolivre.com.br/fone-bluetooth",
          },
          { keyword: "", url: "https://x" },
          { keyword: "caixa de som", url: "javascript:alert(1)" },
        ]);
      },
    });
    await expect(catalog.readTrends("MLB1000")).resolves.toEqual([
      {
        keyword: "fone bluetooth",
        url: "https://lista.mercadolivre.com.br/fone-bluetooth",
      },
      { keyword: "caixa de som", url: null },
    ]);
    expect(paths).toEqual(["/trends/MLB/MLB1000"]);
  });
  it("reads site-wide trends without a category", async () => {
    const paths: string[] = [];
    const catalog = new MercadoLivreCatalog({
      request: async (path: string) => {
        paths.push(path);
        return response(200, []);
      },
    });
    await catalog.readTrends();
    expect(paths).toEqual(["/trends/MLB"]);
  });
  it("rejects a malformed category and maps 404 and provider failures", async () => {
    await expect(
      new MercadoLivreCatalog(routedClient({})).readTrends("../users/me"),
    ).rejects.toThrow("invalid_category");
    await expect(
      new MercadoLivreCatalog(routedClient({ "/trends": response(404, {}) })).readTrends("MLB9"),
    ).rejects.toThrow("category_not_found");
    await expect(
      new MercadoLivreCatalog(routedClient({ "/trends": response(429, {}) })).readTrends(),
    ).rejects.toThrow("rate_limited");
  });
});
