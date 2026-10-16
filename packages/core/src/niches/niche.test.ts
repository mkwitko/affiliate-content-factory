import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createNiche, nicheSlug } from "./niche.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

describe("niche domain", () => {
  it("requires a concrete audience and monetization hypothesis", () => {
    expect(() =>
      createNiche({
        workspaceId,
        name: "Home office",
        audience: "",
        problem: "Disorganized desk",
        editorialVoice: "Practical",
        languages: ["pt-BR"],
        monetizationHypothesis: "",
      }),
    ).toThrow("Niche audience is required");
  });

  it("normalizes and freezes a workspace-owned niche", () => {
    const niche = createNiche({
      id: "niche-1",
      workspaceId,
      name: "Home office",
      audience: "Remote workers",
      problem: "Disorganized desk",
      editorialVoice: "Practical",
      languages: ["pt-BR"],
      monetizationHypothesis: "Affiliate products solve setup gaps",
    });

    expect(niche).toMatchObject({ id: "niche-1", workspaceId, state: "draft" });
    expect(Object.isFrozen(niche)).toBe(true);
    expect(Object.isFrozen(niche.languages)).toBe(true);
  });
});
describe("niche slug", () => {
  it("turns the name into a readable url-safe handle with a short suffix", () => {
    expect(nicheSlug("Example Shop — Decoração & Casa", "3f9a")).toBe(
      "example-shop-decoracao-casa-3f9a",
    );
    expect(nicheSlug("!!!", "0000")).toBe("nicho-0000");
    expect(nicheSlug("Tech")).toMatch(/^tech-[0-9a-f]{8}$/);
  });
});

describe("niche kind", () => {
  const base = {
    workspaceId,
    name: "How The World Works",
    audience: "curious adults",
    problem: "systems feel opaque",
    editorialVoice: "clear, warm",
    languages: ["en-US"],
    monetizationHypothesis: "none yet",
  };
  it("defaults to affiliate", () => {
    expect(createNiche(base).kind).toBe("affiliate");
  });
  it("accepts media", () => {
    expect(createNiche({ ...base, kind: "media" }).kind).toBe("media");
  });
});
