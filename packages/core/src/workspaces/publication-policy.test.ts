import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  changePublicationPolicy,
  createDefaultPublicationPolicy,
  evaluateAutomationPolicy,
  type PublicationPolicy,
} from "./publication-policy.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");

describe("publication policy", () => {
  it("blocks stale evidence", () => {
    const policy = {
      ...createDefaultPublicationPolicy(workspaceId),
      mode: "policy_based" as const,
      evidenceMaxAgeDays: 1,
    };
    expect(
      evaluateAutomationPolicy(
        policy,
        {
          channelId: "c",
          nicheId: "n",
          offerId: "o",
          format: "feed",
          language: "pt-BR",
          claimKeys: [],
          evidenceVerifiedAt: new Date("2026-01-01"),
          now: new Date("2026-01-03"),
        },
        { publicationsInPeriod: 0, itemCostMinor: 0, periodCostMinor: 0 },
      ),
    ).toEqual({ allowed: false, code: "evidence_expired" });
  });
  it("creates every new workspace in manual mode at version one", () => {
    expect(createDefaultPublicationPolicy(workspaceId)).toEqual({
      workspaceId,
      mode: "manual",
      version: 1,
    });
  });

  it("increments the policy version when the mode changes", () => {
    const policy = createDefaultPublicationPolicy(workspaceId);

    expect(changePublicationPolicy(policy, "policy_based")).toEqual({
      workspaceId,
      mode: "policy_based",
      version: 2,
    });
  });

  it("rejects invalid persisted policy versions", () => {
    expect(() =>
      changePublicationPolicy(
        { workspaceId, mode: "manual", version: 0 } as PublicationPolicy,
        "paused",
      ),
    ).toThrow("Publication policy version is invalid");
  });
});
