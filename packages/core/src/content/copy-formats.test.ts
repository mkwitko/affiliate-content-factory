import { describe, expect, it } from "vitest";
import { beatsFor, COPY_FORMAT_IDS, COPY_FORMATS, selectCopyFormat } from "./copy-formats.js";
import { buildOfferCopyInput, buildOfferCopyMessages } from "./offer-copy.js";

describe("copy format catalog", () => {
  it("has one beat per slide in every format", () => {
    for (const id of COPY_FORMAT_IDS) expect(COPY_FORMATS[id].beats).toHaveLength(6);
  });

  it("is deterministic and rotates across item ids", () => {
    const pick = (seed: string) =>
      selectCopyFormat({ seed, hasQuestions: true, characterName: "Carla" }).id;
    expect(pick("item-1")).toBe(pick("item-1"));
    const seen = new Set(Array.from({ length: 60 }, (_, i) => pick(`item-${i}`)));
    expect(seen.size).toBe(COPY_FORMAT_IDS.length);
  });

  it("skips formats the packet cannot feed", () => {
    for (let i = 0; i < 60; i += 1) {
      const id = selectCopyFormat({ seed: `x${i}`, hasQuestions: false }).id;
      expect(id).not.toBe("duvida_respondida");
      expect(id).not.toBe("mini_historia");
    }
  });
});

describe("beatsFor", () => {
  const fed = { hasBuyerVoice: true, title: "Estante 3 Prateleiras" };
  it("keeps every beat when the packet feeds it and drops what it cannot feed", () => {
    expect(beatsFor(COPY_FORMATS.problema_do_dia, fed)).toHaveLength(6);
    expect(
      beatsFor(COPY_FORMATS.problema_do_dia, { hasBuyerVoice: false, title: "Cesto" }),
    ).toEqual(
      COPY_FORMATS.problema_do_dia.beats.filter(
        (beat) => !beat.startsWith("pain:") && !beat.startsWith("concrete detail:"),
      ),
    );
    expect(
      beatsFor(COPY_FORMATS.mini_historia, { hasBuyerVoice: false, title: "Cesto" }),
    ).toHaveLength(6);
  });
  it("never goes below the range floor", () => {
    for (const id of COPY_FORMAT_IDS)
      expect(
        beatsFor(COPY_FORMATS[id], { hasBuyerVoice: false, title: "Cesto" }).length,
      ).toBeGreaterThanOrEqual(3);
  });
});

describe("copy format in the packet", () => {
  const base = {
    title: "Estante Plástica Modular 3 Prateleiras",
    facts: [],
    voice: null,
    niche: { name: "Casa", editorialVoice: "direta", languages: ["pt-BR"] },
    channels: ["threads"] as const,
  };

  it("has no format without a seed", () => {
    expect(buildOfferCopyInput(base).format).toBeUndefined();
  });

  it("carries beats and rules, and the character only for the story format", () => {
    const inputs = Array.from({ length: 40 }, (_, i) =>
      buildOfferCopyInput({ ...base, seed: `s${i}`, characterName: "Carla" }),
    );
    const story = inputs.find((f) => f.format?.id === "mini_historia");
    const other = inputs.find((f) => f.format?.id === "problema_do_dia");
    expect(story?.format?.character).toBe("Carla");
    expect(other?.format?.character).toBeUndefined();
    // No buyer voice in the packet: the pain beat goes; the title's "3" keeps the detail beat.
    expect(other?.format?.beats).toHaveLength(5);
    expect(other?.slideCount).toBe(5);
    const [system, user] = buildOfferCopyMessages(other as NonNullable<typeof other>);
    expect(system?.content).toMatch(/follow it: slide N writes beat N/);
    expect(system?.content).toMatch(/organize sua rotina/);
    expect(user?.content).toContain('"format"');
  });
});
