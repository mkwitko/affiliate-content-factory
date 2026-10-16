import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { ResearchSnapshot } from "./research-snapshot.js";
import { buildNicheResearchContext } from "./niche-context.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const snapshot = (overrides: Partial<ResearchSnapshot>): ResearchSnapshot => ({
  id: "snapshot-1",
  workspaceId,
  provider: "manual",
  nicheId: "niche-1",
  query: "cafeteira",
  locale: "pt-BR",
  observedAt: new Date("2026-09-21T00:00:00.000Z"),
  expiresAt: new Date("2026-09-28T00:00:00.000Z"),
  observations: [],
  contentHash: "hash-1",
  actorId,
  ...overrides,
});

describe("buildNicheResearchContext", () => {
  it("buckets recognized observation keys and de-duplicates values", () => {
    const context = buildNicheResearchContext([
      snapshot({
        observations: [
          { id: "obs-a", key: "keyword", value: "cafeteira portátil", sourceUrl: "https://a.test" },
          { id: "obs-b", key: "keyword", value: "cafeteira portátil", sourceUrl: "https://b.test" },
          { id: "obs-c", key: "pain", value: "entrega demorada", sourceUrl: "https://c.test" },
          { id: "obs-d", key: "reference_product", value: "MLB123", sourceUrl: "https://d.test" },
          {
            id: "obs-e",
            key: "exclusion",
            value: "cafeteira industrial",
            sourceUrl: "https://e.test",
          },
          { id: "obs-f", key: "unrecognized_key", value: "ignored", sourceUrl: "https://f.test" },
        ],
      }),
    ]);

    expect(context).toEqual({
      keywords: ["cafeteira portátil"],
      pains: ["entrega demorada"],
      referenceProducts: ["MLB123"],
      exclusions: ["cafeteira industrial"],
    });
  });

  it("returns empty buckets for no snapshots", () => {
    expect(buildNicheResearchContext([])).toEqual({
      keywords: [],
      pains: [],
      referenceProducts: [],
      exclusions: [],
    });
  });
});
