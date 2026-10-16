import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { createResearchSnapshot } from "./research-snapshot.js";
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const observation = {
  key: "keyword",
  value: "cafeteira portátil",
  sourceUrl: "https://vidiq.example/keyword",
};
const input = {
  workspaceId,
  actorId,
  provider: "vidiq" as const,
  query: "cafeteira",
  locale: "pt-BR",
  observedAt: new Date("2026-09-21T12:00:00Z"),
  expiresAt: new Date("2026-09-28T12:00:00Z"),
  observations: [observation],
};
describe("research snapshots", () => {
  it("requires attributable observations and hashes normalized content", () => {
    expect(() => createResearchSnapshot({ ...input, observations: [] })).toThrow(
      "Research observations are required",
    );
    expect(createResearchSnapshot(input).contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["https://x.test/a", "javascript:alert(1)"])("validates sources (%s)", (sourceUrl) => {
    if (sourceUrl.startsWith("https://"))
      expect(() =>
        createResearchSnapshot({
          ...input,
          observations: [{ ...observation, sourceUrl }],
        }),
      ).not.toThrow();
    else
      expect(() =>
        createResearchSnapshot({
          ...input,
          observations: [{ ...observation, sourceUrl }],
        }),
      ).toThrow("URL is invalid");
  });
  it("rejects duplicate observations and invalid expiry", () => {
    expect(() =>
      createResearchSnapshot({
        ...input,
        observations: [observation, observation],
      }),
    ).toThrow("unique");
    expect(() => createResearchSnapshot({ ...input, expiresAt: input.observedAt })).toThrow(
      "expiry",
    );
  });
  it("accepts an optional niche id and the mercado_livre/manual providers", () => {
    const snapshot = createResearchSnapshot({
      workspaceId,
      provider: "manual",
      nicheId: "niche-1",
      query: "cafeteira portátil",
      locale: "pt-BR",
      observedAt: new Date("2026-09-21T12:00:00.000Z"),
      expiresAt: new Date("2026-09-28T12:00:00.000Z"),
      observations: [
        { key: "keyword", value: "cafeteira portátil", sourceUrl: "https://example.test/a" },
      ],
      actorId,
    });

    expect(snapshot.nicheId).toBe("niche-1");
    expect(snapshot.provider).toBe("manual");
  });

  it("hashes the same observations differently per niche id", () => {
    const withoutNiche = createResearchSnapshot(input);
    const withNicheA = createResearchSnapshot({ ...input, nicheId: "niche-a" });
    const withNicheB = createResearchSnapshot({ ...input, nicheId: "niche-b" });

    expect(withNicheA.contentHash).not.toBe(withoutNiche.contentHash);
    expect(withNicheA.contentHash).not.toBe(withNicheB.contentHash);
  });

  it("defaults niche id to null when omitted", () => {
    const snapshot = createResearchSnapshot({
      workspaceId,
      provider: "mercado_livre",
      query: "cafeteira",
      locale: "pt-BR",
      observedAt: new Date("2026-09-21T12:00:00.000Z"),
      expiresAt: new Date("2026-09-28T12:00:00.000Z"),
      observations: [
        { key: "pain", value: "entrega demorada", sourceUrl: "https://example.test/b" },
      ],
      actorId,
    });

    expect(snapshot.nicheId).toBeNull();
  });
});
