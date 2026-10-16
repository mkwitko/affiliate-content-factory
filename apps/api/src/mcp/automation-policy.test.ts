import { describe, expect, it } from "vitest";
import { evaluateAutomationPolicy } from "@money-maker/core/workspaces/publication-policy";
describe("automation policy MCP contract", () => {
  it("keeps policy decisions bounded", () => {
    expect(
      evaluateAutomationPolicy(
        { workspaceId: "w" as never, mode: "paused", version: 1 },
        {
          channelId: "c",
          nicheId: "n",
          offerId: "o",
          format: "feed",
          language: "pt-BR",
          claimKeys: [],
          evidenceVerifiedAt: new Date(),
        },
        { publicationsInPeriod: 0, itemCostMinor: 0, periodCostMinor: 0 },
      ),
    ).toEqual({ allowed: false, code: "policy_paused" });
  });
});
