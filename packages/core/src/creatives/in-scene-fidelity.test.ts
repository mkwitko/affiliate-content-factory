import { describe, expect, it } from "vitest";
import {
  type ColourEvidence,
  judgeInSceneFidelity,
  parseReferenceAnswer,
  parseSubjectBoxes,
  parseVlmFidelityAnswer,
  productVisualSpecFor,
  storedSubjectBoxes,
  type VlmFidelityAnswer,
  vlmFidelityJsonSchema,
  vlmFidelityPrompt,
  vlmReferencePrompt,
} from "./in-scene-fidelity.js";

const features = (title: string) => productVisualSpecFor(title).features;

describe("productVisualSpecFor", () => {
  it("extracts counted features from real titles", () => {
    expect(
      features(
        "Estante Plástica 3 Prateleiras Multiuso Organização Casa Lavanderia Banheiro Cozinha",
      ),
    ).toEqual([{ key: "shelves", value: 3 }]);
    expect(features("Porta tempero giratório com 12 potes")).toEqual([{ key: "pots", value: 12 }]);
    expect(features("10pcs Pincel Maquiagem Profissionais Kit")).toEqual([
      { key: "pieces", value: 10 },
    ]);
    expect(features("Kit 10 peças escova")).toEqual([{ key: "pieces", value: 10 }]);
    expect(features("Cômoda com 2 gavetas")).toEqual([{ key: "drawers", value: 2 }]);
  });
  it("finds nothing countable in titles without counts", () => {
    expect(features("Organizador Maquiagem Caixa Acrílico Transparente Portátil")).toEqual([]);
    // "5.3" is a version, not a count.
    expect(features("Fone Ouvido Sem Fio Tws Bluetooth 5.3, Fone Ouvido")).toEqual([]);
  });
  it("reads verified string facts too and carries the generic mutations", () => {
    const spec = productVisualSpecFor("Estante", [
      { key: "attr", value: "2 gavetas", sourceUrl: "x", verified: true },
      { key: "attr2", value: "9 potes", sourceUrl: "x", verified: false },
    ]);
    expect(spec.features).toEqual([{ key: "drawers", value: 2 }]);
    expect(spec.forbiddenMutations).toContain("different colour");
    expect(spec.evidence).toEqual([{ field: "count:drawers", value: "2", source: "fact:attr" }]);
  });
  it("knows a rotating rack shows only some of its parts: more blocks, fewer passes", () => {
    const rack = productVisualSpecFor("Porta tempero giratório com 12 potes");
    expect(rack.partsAroundAxis).toBe(true);
    expect(rack.evidence).toContainEqual({
      field: "parts_around_axis",
      value: "true",
      source: "title",
    });
    expect(productVisualSpecFor("Estante 3 prateleiras").partsAroundAxis).toBeUndefined();
    const vlm = (pots: number) => ({
      productPresent: true,
      sameProductAsReference: true,
      counts: { pots },
      inventedTextOrLogo: false,
      notes: "",
    });
    const colour = [{ productShare: 0.6, scenePresence: 0.3 }];
    expect(judgeInSceneFidelity({ spec: rack, vlm: vlm(8), colour }).verdict).toBe("pass");
    expect(judgeInSceneFidelity({ spec: rack, vlm: vlm(14), colour }).reasons).toEqual([
      "count_mismatch:pots",
    ]);
    expect(judgeInSceneFidelity({ spec: rack, vlm: vlm(4), colour })).toEqual({
      verdict: "review",
      reasons: ["count_low:pots"],
    });
  });
  it("names materials only from words in the title or verified facts, with their source", () => {
    const steel = productVisualSpecFor("Porta Tempero Giratório Aço Inox 16 Potes Vidro");
    expect(steel.materials).toEqual(["stainless steel", "glass"]);
    expect(steel.evidence).toContainEqual({
      field: "material",
      value: "stainless steel",
      source: "title",
    });
    expect(productVisualSpecFor("Estante Plástica 3 Prateleiras").materials).toEqual(["plastic"]);
    expect(productVisualSpecFor("Sapateira Aço Preto").materials).toEqual(["metal"]);
    expect(
      productVisualSpecFor("Estante", [
        { key: "material", value: "MDF", sourceUrl: "x", verified: true },
      ]).evidence,
    ).toEqual([{ field: "material", value: "wood", source: "fact:material" }]);
    // "Espaço" holds "aço" inside a word: not a material.
    expect(productVisualSpecFor("Organizador Economiza Espaço").materials).toBeUndefined();
  });
});

const spec = productVisualSpecFor("Estante 3 Prateleiras");
const good: VlmFidelityAnswer = {
  productPresent: true,
  sameProductAsReference: true,
  counts: { shelves: 3 },
  inventedTextOrLogo: false,
  notes: "",
};
const colourOk: ColourEvidence = [{ productShare: 0.8, scenePresence: 0.05 }];

describe("judgeInSceneFidelity", () => {
  it("passes only with VLM and colour both ok", () => {
    expect(judgeInSceneFidelity({ spec, vlm: good, colour: colourOk })).toEqual({
      verdict: "pass",
      reasons: [],
    });
  });
  it("never auto-passes without the VLM or the colour check", () => {
    expect(judgeInSceneFidelity({ spec, colour: colourOk }).verdict).toBe("review");
    expect(judgeInSceneFidelity({ spec, vlm: good }).verdict).toBe("review");
  });
  it("blocks on a different product, wrong count, invented text or absent product", () => {
    const run = (patch: Partial<VlmFidelityAnswer>) =>
      judgeInSceneFidelity({ spec, vlm: { ...good, ...patch }, colour: colourOk });
    expect(run({ sameProductAsReference: false }).reasons).toContain(
      "product_differs_from_reference",
    );
    expect(run({ counts: { shelves: 4 } }).reasons).toEqual(["count_mismatch:shelves"]);
    expect(run({ inventedTextOrLogo: true }).verdict).toBe("block");
    expect(run({ productPresent: false }).verdict).toBe("block");
  });
  it("routes an uncountable feature to review", () => {
    expect(
      judgeInSceneFidelity({ spec, vlm: { ...good, counts: { shelves: null } }, colour: colourOk }),
    ).toEqual({ verdict: "review", reasons: ["count_unknown:shelves"] });
  });
  it("blocks when a dominant reference colour is absent from the scene, even if the VLM agrees", () => {
    expect(
      judgeInSceneFidelity({
        spec,
        vlm: good,
        colour: [{ productShare: 0.7, scenePresence: 0.0001 }],
      }),
    ).toEqual({ verdict: "block", reasons: ["colour_mismatch"] });
  });
  it("ignores minor colours", () => {
    expect(
      judgeInSceneFidelity({
        spec,
        vlm: good,
        colour: [
          { productShare: 0.8, scenePresence: 0.05 },
          { productShare: 0.05, scenePresence: 0 },
        ],
      }).verdict,
    ).toBe("pass");
  });
});

describe("VLM prompt and parser", () => {
  it("names the schema and the counted keys", () => {
    expect(vlmFidelityPrompt(spec)).toContain("shelves");
    expect(vlmFidelityPrompt(spec)).toContain("sameProductAsReference");
  });
  it("accepts exactly the schema", () => {
    expect(parseVlmFidelityAnswer({ ...good }, spec)).toEqual(good);
  });
  it.each([
    ["extra field", { ...good, extra: 1 }],
    ["missing field", { ...good, notes: undefined }],
    ["string boolean", { ...good, productPresent: "true" }],
    ["missing count key", { ...good, counts: {} }],
    ["extra count key", { ...good, counts: { shelves: 3, pots: 1 } }],
    ["float count", { ...good, counts: { shelves: 3.5 } }],
    ["string count", { ...good, counts: { shelves: "3" } }],
    ["json string", JSON.stringify(good)],
    ["array", []],
  ])("rejects %s", (_name, value) => {
    expect(parseVlmFidelityAnswer(value, spec)).toBeNull();
  });
});

describe("subject boxes", () => {
  const face = { kind: "face", box: [400, 100, 600, 300] } as const;
  const product = { kind: "product", box: [100, 500, 400, 950] } as const;

  it("asks for 0..1000 boxes in the prompt and the schema", () => {
    expect(vlmFidelityPrompt(spec)).toContain("integers from 0 to 1000");
    expect(vlmFidelityPrompt(spec)).toContain('"subjects"');
  });
  it("keeps valid boxes on the answer without changing the verdict", () => {
    const parsed = parseVlmFidelityAnswer({ ...good, subjects: [face, product] }, spec);
    expect(parsed?.subjects).toEqual([face, product]);
    expect(judgeInSceneFidelity({ spec, vlm: parsed ?? undefined }).verdict).toBe(
      judgeInSceneFidelity({ spec, vlm: good }).verdict,
    );
  });
  it.each([
    ["float", [{ kind: "face", box: [1.5, 2, 3, 4] }]],
    ["out of range", [{ kind: "face", box: [0, 0, 1001, 10] }]],
    ["negative", [{ kind: "face", box: [-1, 0, 10, 10] }]],
    ["x0 >= x1", [{ kind: "face", box: [10, 0, 10, 10] }]],
    ["y0 >= y1", [{ kind: "face", box: [0, 20, 10, 10] }]],
    ["three numbers", [{ kind: "face", box: [0, 0, 10] }]],
    ["unknown kind", [{ kind: "hand", box: [0, 0, 10, 10] }]],
    ["extra field", [{ ...face, label: "x" }]],
    ["more than 8", Array.from({ length: 9 }, () => face)],
    ["not an array", face],
  ])("drops the whole list on %s but keeps the fidelity answer", (_name, subjects) => {
    expect(parseSubjectBoxes(subjects)).toBeNull();
    expect(parseVlmFidelityAnswer({ ...good, subjects }, spec)).toEqual(good);
  });
  it("reads boxes stored under inSceneFidelity.vlm", () => {
    expect(storedSubjectBoxes({ vlm: { ...good, subjects: [face] } })).toEqual([face]);
    expect(storedSubjectBoxes({ vlm: good })).toBeUndefined();
    expect(storedSubjectBoxes(undefined)).toBeUndefined();
  });
});

describe("people count", () => {
  const spec = productVisualSpecFor("Estante 3 prateleiras");
  const base = {
    productPresent: true,
    sameProductAsReference: true,
    counts: Object.fromEntries(spec.features.map((f) => [f.key, f.value])),
    inventedTextOrLogo: false,
    notes: "",
  };

  it("parses the count when present and accepts older answers without it", () => {
    expect(parseVlmFidelityAnswer({ ...base, peopleCount: 2 }, spec)?.peopleCount).toBe(2);
    expect(parseVlmFidelityAnswer(base, spec)?.peopleCount).toBeUndefined();
    expect(parseVlmFidelityAnswer({ ...base, peopleCount: -1 }, spec)).toBeNull();
    expect(parseVlmFidelityAnswer({ ...base, peopleCount: 1.5 }, spec)).toBeNull();
  });

  it("blocks an extra person only when the slide's people count is known", () => {
    const colour = undefined;
    const two = { ...base, peopleCount: 2 };
    expect(judgeInSceneFidelity({ spec, vlm: two, colour, expectedPeople: 1 }).reasons).toContain(
      "extra_person",
    );
    expect(judgeInSceneFidelity({ spec, vlm: two, colour }).reasons).not.toContain("extra_person");
    expect(judgeInSceneFidelity({ spec, vlm: base, colour, expectedPeople: 0 }).reasons).toContain(
      "people_unknown",
    );
  });

  it("asks the VLM for the count", () => {
    expect(vlmFidelityJsonSchema(spec).required).toContain("peopleCount");
    expect(vlmFidelityPrompt(spec)).toContain("peopleCount");
  });
});

describe("parseReferenceAnswer", () => {
  it("is clean only when the photo shows the product alone; malformed is null", () => {
    expect(parseReferenceAnswer({ cleanProduct: true, extras: [], note: "" })).toEqual({
      clean: true,
      extras: [],
    });
    expect(
      parseReferenceAnswer({ cleanProduct: true, extras: ["text_or_badges", "props"], note: "" }),
    ).toEqual({ clean: false, extras: ["text_or_badges", "props"] });
    expect(parseReferenceAnswer({ cleanProduct: false, extras: [], note: "" })).toMatchObject({
      clean: false,
    });
    expect(parseReferenceAnswer({ cleanProduct: true, extras: ["cats"], note: "" })).toBeNull();
    expect(parseReferenceAnswer("yes")).toBeNull();
    expect(vlmReferencePrompt('Porta "tempero"')).toContain("Porta 'tempero'");
  });
});

describe("vlmCountPrompt", () => {
  it("asks on the scene alone with a wording per feature and a generic fallback", async () => {
    const { vlmCountPrompt, vlmCountJsonSchema } = await import("./in-scene-fidelity.js");
    expect(vlmCountPrompt("shelves")).toContain("bottom board included");
    expect(vlmCountPrompt("pots")).toContain("every separate pot");
    expect(vlmCountJsonSchema("pots").required).toEqual(["pots"]);
  });
});

describe("placement", () => {
  it("sends furniture off the floor or anything floating to review, never blocks", async () => {
    const { judgeInSceneFidelity, parseVlmFidelityAnswer, productVisualSpecFor } = await import(
      "./in-scene-fidelity.js"
    );
    const rack = productVisualSpecFor("Estante Plástica 3 Prateleiras");
    const pot = productVisualSpecFor("Pote Hermético");
    expect(rack.standsOnFloor).toBe(true);
    expect(pot.standsOnFloor).toBeUndefined();
    const base = {
      productPresent: true,
      sameProductAsReference: true,
      inventedTextOrLogo: false,
      notes: "",
      peopleCount: 0,
    };
    const colour = [{ productShare: 0.6, scenePresence: 0.3 }];
    const judge = (spec: typeof rack, counts: object, placement: object) =>
      judgeInSceneFidelity({
        spec,
        vlm: parseVlmFidelityAnswer({ ...base, counts, placement }, spec) ?? undefined,
        colour,
        expectedPeople: 0,
      });
    const onTable = { restingOn: "counter_or_table", note: "on a table" };
    expect(judge(rack, { shelves: 3 }, onTable)).toEqual({
      verdict: "review",
      reasons: ["placement_off_floor:counter_or_table"],
    });
    expect(judge(pot, {}, onTable).verdict).toBe("pass");
    expect(judge(pot, {}, { restingOn: "floating", note: "" })).toEqual({
      verdict: "review",
      reasons: ["placement_floating"],
    });
    expect(judge(rack, { shelves: 3 }, { restingOn: "held", note: "" }).verdict).toBe("pass");
    // A malformed answer is dropped and changes nothing.
    expect(judge(rack, { shelves: 3 }, { restingOn: "table" }).verdict).toBe("pass");
  });
});
