import { describe, expect, it } from "vitest";
import { activeFacts, checkNewFacts, relevantFacts } from "./continuity.js";
import { RECURRING_FACTS } from "./fixtures.js";
import type { ContinuityFact } from "./story.js";

const fact = (id: string, over: Partial<ContinuityFact> = {}): ContinuityFact => ({
  id,
  episodeId: "e1",
  kind: "event",
  subject: "carla",
  predicate: "did something",
  salience: 2,
  ...over,
});

describe("activeFacts", () => {
  it("drops superseded facts along the whole chain", () => {
    const chain = [fact("a"), fact("b", { supersedes: "a" }), fact("c", { supersedes: "b" })];
    expect(activeFacts(chain).map((f) => f.id)).toEqual(["c"]);
  });
  it("drops facts past their expiry episode", () => {
    const facts = [fact("a", { expiresEpisode: 2 }), fact("b")];
    expect(activeFacts(facts, 2).map((f) => f.id)).toEqual(["a", "b"]);
    expect(activeFacts(facts, 3).map((f) => f.id)).toEqual(["b"]);
  });
});

describe("relevantFacts", () => {
  it("keeps only facts about the cast, ranked by salience then recency", () => {
    const facts = [
      fact("old3", { salience: 3 }),
      fact("low", { salience: 1 }),
      fact("new2", { salience: 2 }),
      fact("older2", { salience: 2 }),
      fact("other", { subject: "zed", salience: 3 }),
      fact("obj", { subject: "zed", object: "carla", salience: 2 }),
    ];
    expect(relevantFacts({ facts, castIds: ["carla"] }).map((f) => f.id)).toEqual([
      "old3",
      "obj",
      "older2",
      "new2",
      "low",
    ]);
  });
  it("caps the result at 12 by default", () => {
    const facts = Array.from({ length: 20 }, (_, i) => fact(`f${i}`));
    expect(relevantFacts({ facts, castIds: ["carla"] })).toHaveLength(12);
    expect(relevantFacts({ facts, castIds: ["carla"], limit: 3 })).toHaveLength(3);
  });
});

describe("checkNewFacts", () => {
  const holds = (id: string, who: string, item: string, over: Partial<ContinuityFact> = {}) =>
    fact(id, { kind: "possession", subject: who, predicate: "has", object: item, ...over });
  const at = (id: string, who: string, place: string, over: Partial<ContinuityFact> = {}) =>
    fact(id, { kind: "location", subject: who, predicate: "is_at", object: place, ...over });

  it("rejects a second holder of the same item unless the old fact is superseded", () => {
    const existing = [holds("h1", "rafa", "key")];
    expect(checkNewFacts(existing, [holds("h2", "bia", "key")])).toEqual([
      "possession_conflict:key",
    ]);
    expect(checkNewFacts(existing, [holds("h2", "bia", "key", { supersedes: "h1" })])).toEqual([]);
  });
  it("rejects a subject in two places unless it moves via supersedes", () => {
    const existing = [at("l1", "bia", "shop")];
    expect(checkNewFacts(existing, [at("l2", "bia", "park")])).toEqual(["location_conflict:bia"]);
    expect(checkNewFacts(existing, [at("l2", "bia", "park", { supersedes: "l1" })])).toEqual([]);
    expect(checkNewFacts(existing, [at("l2", "carla", "park")])).toEqual([]);
  });
  it("checks conflicts inside one batch", () => {
    expect(checkNewFacts([], [holds("h1", "rafa", "key"), holds("h2", "bia", "key")])).toEqual([
      "possession_conflict:key",
    ]);
  });
  it("rejects duplicate ids and unknown supersedes", () => {
    expect(checkNewFacts([fact("a")], [fact("a")])).toEqual(["duplicate_fact:a"]);
    expect(checkNewFacts([], [fact("b", { supersedes: "nope" })])).toEqual([
      "supersedes_unknown:b",
    ]);
  });
  it("allows the same fact text to be repeated by a new id for non-exclusive kinds", () => {
    expect(checkNewFacts([fact("a")], [fact("b")])).toEqual([]);
  });
});

describe("recurring-continuity fixture", () => {
  it("spans three episodes without contradiction", () => {
    let stored: ContinuityFact[] = [];
    for (const episode of RECURRING_FACTS) {
      expect(checkNewFacts(stored, episode)).toEqual([]);
      stored = [...stored, ...episode];
    }
    expect(stored.length).toBeGreaterThan(3);
    const cast = ["carla", "bia", "rafa"];
    expect(
      relevantFacts({ facts: stored, castIds: cast, currentEpisode: 3 }).length,
    ).toBeLessThanOrEqual(12);
    // the key ended with Bia: only one active holder
    const keys = activeFacts(stored).filter((f) => f.kind === "possession" && f.object === "key");
    expect(keys.map((f) => f.subject)).toEqual(["bia"]);
  });
  it("catches a contradiction in episode 3", () => {
    const [e1, e2] = RECURRING_FACTS;
    const bad: ContinuityFact = {
      id: "bad",
      episodeId: "shop-3",
      kind: "possession",
      subject: "carla",
      predicate: "has",
      object: "key",
      salience: 3,
    };
    expect(checkNewFacts([...(e1 ?? []), ...(e2 ?? [])], [bad])).toEqual([
      "possession_conflict:key",
    ]);
  });
});
