import { describe, expect, it } from "vitest";
import { MercadoLivreCatalog } from "@money-maker/providers/mercado-livre/catalog";
describe("Mercado Livre MCP boundary", () => {
  it("keeps catalog output normalized", async () => {
    const catalog = new MercadoLivreCatalog({
      request: async (path: string) => ({
        status: 200,
        json: async () =>
          path.startsWith("/products/search")
            ? { results: [{ id: "MLB1" }] }
            : {
                name: "Produto",
                permalink: "https://mercadolivre.com.br/p/MLB1",
                buy_box_winner: {
                  item_id: "MLB1X",
                  price: 10,
                  currency_id: "BRL",
                  available_quantity: 1,
                  seller_id: 1,
                },
              },
      }),
    });
    await expect(catalog.search({ query: "produto", limit: 1 })).resolves.toHaveLength(1);
  });
});
