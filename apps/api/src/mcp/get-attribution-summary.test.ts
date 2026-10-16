import { describe, expect, it } from "vitest";
import { getAttributionSummaryInputSchema } from "./tools/get-attribution-summary.js";
describe("attribution summary", () => {
  it("accepts publication grouping without changing the default", () => {
    const workspaceId = "0d7702aa-a69d-4f49-842a-c1a13e72160d";
    expect(getAttributionSummaryInputSchema.parse({ workspaceId }).groupBy).toBe("niche");
    expect(
      getAttributionSummaryInputSchema.parse({ workspaceId, groupBy: "publication" }).groupBy,
    ).toBe("publication");
  });
});
