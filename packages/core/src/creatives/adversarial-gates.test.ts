import { describe, expect, it } from "vitest";
import { copyTextCode } from "../content/offer-copy.js";
import { numbersWithoutEvidence } from "../content/preview-content.js";
import type { CommercialFact } from "../offers/offer.js";
import { compareNarration } from "../publishing/narration-check.js";
import { withMusicCheck } from "../publishing/render-quality.js";
import { judgeInSceneFidelity, productVisualSpecFor } from "./in-scene-fidelity.js";
import { PLATFORM_PRESETS } from "./platform-presets.js";
import { directQuality } from "./quality-director.js";
import { SHOT_FOR_TEMPLATE, sceneLineProblem } from "./scene-direction.js";
import { judgeCarouselSequence } from "./sequence-quality.js";
import { judgeSlideQuality } from "./slide-quality.js";

/**
 * Owner brief 2026-10-08, section 20: deliberately wrong inputs that the automatic gates must
 * never let through. One table per gate; a row that starts passing is a regression.
 */
const title = "Estante Plástica 3 Prateleiras Multiuso";
const spec = productVisualSpecFor(title);
const facts: readonly CommercialFact[] = [
  {
    key: "current_price",
    value: { amountMinor: 8990, currency: "BRL" },
    sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
    verified: true,
  },
];
const goodScene = {
  productPresent: true,
  sameProductAsReference: true,
  counts: { shelves: 3 },
  inventedTextOrLogo: false,
  notes: "",
  peopleCount: 1,
};
const colourOk = [{ productShare: 0.6, scenePresence: 0.3 }];

describe("adversarial inputs the scene gate must block", () => {
  it.each([
    [
      "wrong shelf count",
      { ...goodScene, counts: { shelves: 4 } },
      colourOk,
      "count_mismatch:shelves",
    ],
    [
      "a different product",
      { ...goodScene, sameProductAsReference: false },
      colourOk,
      "product_differs_from_reference",
    ],
    [
      "an invented logo",
      { ...goodScene, inventedTextOrLogo: true },
      colourOk,
      "invented_text_or_logo",
    ],
    ["no product at all", { ...goodScene, productPresent: false }, colourOk, "product_absent"],
    ["a duplicated person", { ...goodScene, peopleCount: 2 }, colourOk, "extra_person"],
    ["a person on a product-only shot", { ...goodScene, peopleCount: 1 }, colourOk, "extra_person"],
    ["the wrong colour", goodScene, [{ productShare: 0.6, scenePresence: 0.0 }], "colour_mismatch"],
  ])("blocks %s", (name, vlm, colour, reason) => {
    const judged = judgeInSceneFidelity({
      spec,
      vlm,
      colour,
      expectedPeople: name.includes("product-only") ? 0 : 1,
    });
    expect(judged.verdict).toBe("block");
    expect(judged.reasons).toContain(reason);
  });
  it("passes the honest scene", () => {
    expect(
      judgeInSceneFidelity({ spec, vlm: goodScene, colour: colourOk, expectedPeople: 1 }),
    ).toEqual({ verdict: "pass", reasons: [] });
  });
});

describe("adversarial copy the text gates must refuse", () => {
  it.each([
    [
      "a discount without a list price",
      "Está com 30% de desconto hoje",
      "copy_discount_unverified",
    ],
    [
      "free shipping nobody verified",
      "Frete grátis para todo o Brasil",
      "copy_shipping_unverified",
    ],
    ["a link", "Compre em www.loja.com", "copy_link_not_allowed"],
    ["a testimonial", "Eu testei e amei a estante", "claim_testimonial"],
  ])("refuses %s", (_name, text, code) => {
    expect(copyTextCode([text], facts, title)).toBe(code);
  });
  it("flags a sold count no fact backs and accepts the verified price", () => {
    expect(numbersWithoutEvidence("Já são 500 vendidos", facts).length).toBeGreaterThan(0);
    expect(numbersWithoutEvidence("Por R$ 89,90 hoje", facts)).toEqual([]);
  });
  // Known escapes (v3-plan.md section 3): regex rules miss paraphrases and specification counts.
  // The semantic claim judge (backlog 2) is the fix; these rows flip to `it` when it lands.
  it.fails("a paraphrased testimonial is not caught yet", () => {
    expect(copyTextCode(["Minha cliente disse que mudou a vida dela"], facts, title)).toBe(
      "claim_testimonial",
    );
  });
  it.fails("a specification count no fact lists is not caught yet", () => {
    expect(numbersWithoutEvidence("Cabe 20 pares de sapato", facts)).toEqual(["20"]);
  });
});

describe("adversarial scene lines the director validator must reject", () => {
  const input = {
    product: "a plastic rack",
    character: { name: "Carla", description: "35" },
    otherNames: ["Bia", "Rafa"],
    world: "a small flat",
    slides: [],
  };
  it.each([
    [
      "another recurring character",
      "Carla and Bia arrange the rack together in the laundry corner",
      SHOT_FOR_TEMPLATE.hero,
      "extra_person",
    ],
    [
      "a person on the product hero",
      "Carla stands proudly next to the rack on a clean surface",
      SHOT_FOR_TEMPLATE.price,
      "person_on_product_shot",
    ],
    [
      "a price to draw",
      "The rack with a R$ 89,90 tag on the top shelf in the laundry corner",
      SHOT_FOR_TEMPLATE.price,
      "text_or_price",
    ],
    [
      "a decimal number",
      "The rack measuring 1,20 metres beside the washing machine in the flat",
      SHOT_FOR_TEMPLATE.price,
      "digit",
    ],
  ])("rejects %s", (_name, line, shot, reason) => {
    // A price carries a decimal too; either rule may fire first, both keep it out.
    const problem = sceneLineProblem(line, shot, input);
    expect(reason === "text_or_price" ? ["text_or_price", "digit"] : [reason]).toContain(problem);
  });
});

describe("adversarial audio the Reel gates must not pass silently", () => {
  it("blocks a narration that says another price", () => {
    const check = compareNarration(["Por R$ 89,90 hoje"], "por oitenta e nove reais e noventa", {
      model: "local:parakeet-tdt-0.6b-v3",
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(check.verdict).toBe("pass");
    const wrong = compareNarration(["Por R$ 89,90 hoje"], "por noventa e nove reais e noventa", {
      model: "local:parakeet-tdt-0.6b-v3",
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(wrong.verdict).toBe("block");
  });
  it("warns a Reel without a licensed track instead of passing it clean", () => {
    const report = { version: 1 as const, verdict: "pass" as const, checks: [], measuredAt: "t" };
    expect(withMusicCheck(report, false)?.verdict).toBe("warn");
  });
});

describe("adversarial layouts and packages QA v2 must not pass clean", () => {
  const story = PLATFORM_PRESETS.instagram_story;
  const slide = (boxes: Parameters<typeof judgeSlideQuality>[0]["boxes"], collisions = []) =>
    judgeSlideQuality({
      preset: story,
      canvas: story.canvas,
      boxes,
      collisions,
      image: new Uint8Array([1]),
      textColours: { headline: "#111111" },
      measureContrast: async () => 7,
    });

  it("refuses a headline under the platform's top UI band", async () => {
    const report = await slide({ headline: { x: 100, y: 20, w: 800, h: 150 } });
    expect(report.verdict).toBe("block");
  });

  it("does not pass a headline over a face clean", async () => {
    const report = await slide({ headline: { x: 100, y: 400, w: 800, h: 150 } }, [
      { block: "top", kind: "face", overlap: 0.4 },
    ] as never);
    expect(report.verdict).not.toBe("pass");
  });

  it("blocks a carousel that repeats a scene, and the director names the repair", () => {
    const sequence = judgeCarouselSequence([
      { index: 1, template: "hero", headline: "A", sceneAssetId: "s1" },
      { index: 2, template: "benefit", headline: "B", sceneAssetId: "s1" },
    ]);
    expect(sequence.verdict).toBe("block");
    const direction = directQuality({
      render: { state: "rendered", sequence: sequence.reasons },
    });
    expect(direction.level).toBe("BLOCK");
    expect(direction.findings[0]?.repair).toBe("redraw_duplicate_scene");
  });

  it("never lets the director call a package clean when a gate warned", () => {
    expect(
      directQuality({
        render: { state: "rendered", fidelity: "pass", quality: "warn" },
        reel: { checks: [{ id: "music", verdict: "warn", detail: "no licensed track available" }] },
      }).level,
    ).toBe("WARN");
  });
});
