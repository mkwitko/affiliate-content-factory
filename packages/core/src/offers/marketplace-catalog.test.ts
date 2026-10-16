import { describe, expect, it } from "vitest";
import type { MarketplaceCatalog } from "./marketplace-catalog.js";
describe("marketplace catalog contract", () => {
  it("requires bounded search input", async () => {
    const catalog: MarketplaceCatalog = {
      search: async ({ limit }) => {
        if (limit > 100) throw new Error("invalid_limit");
        return [];
      },
      readBuyerVoice: async () => {
        throw new Error("not_used");
      },
      readProductEvidence: async () => {
        throw new Error("not implemented");
      },
    };
    await expect(catalog.search({ query: "x", limit: 101 })).rejects.toThrow("invalid_limit");
  });
});
