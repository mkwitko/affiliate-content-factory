import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { reserveCost } from "./cost-event.js";
describe("cost events", () => {
  it("does not silently turn unknown usage into zero", () => {
    const event = reserveCost({
      workspaceId: parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d"),
      provider: "openai",
      operation: "image",
      estimatedMinor: 10,
      currency: "USD",
    });
    expect(event.status).toBe("reserved");
    expect(event.actualMinor).toBeUndefined();
  });
});
