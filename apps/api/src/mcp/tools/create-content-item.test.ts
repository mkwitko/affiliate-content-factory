import { describe, expect, it } from "vitest";
import { createContentItemInputSchema } from "./create-content-item.js";

const base = {
  workspaceId: "0d7702aa-a69d-4f49-842a-c1a13e72160d",
  nicheId: "niche-1",
  title: "An editorial idea",
  sourceFactKeys: [],
  creativeOpinion: "Explain a useful idea.",
};

describe("create_content_item input", () => {
  it("accepts a minimal editorial item", () => {
    expect(createContentItemInputSchema.safeParse(base).success).toBe(true);
    expect(
      createContentItemInputSchema.safeParse({ ...base, sourceContentItemId: "master-1" }).success,
    ).toBe(true);
  });

  it("requires commercial facts with an offer and forbids them without one", () => {
    expect(createContentItemInputSchema.safeParse({ ...base, offerId: "offer-1" }).success).toBe(
      false,
    );
    expect(
      createContentItemInputSchema.safeParse({ ...base, sourceFactKeys: ["price"] }).success,
    ).toBe(false);
  });

  it("rejects source product images for editorial content", () => {
    expect(
      createContentItemInputSchema.safeParse({ ...base, sourcePictureAssetIds: ["asset-1"] })
        .success,
    ).toBe(false);
  });
});
