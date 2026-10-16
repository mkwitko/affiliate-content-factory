import { describe, expect, it } from "vitest";
import {
  hasGenericHookOpener,
  type SlideSpec,
  validateSlideDeckQuality,
  validateSlideSpec,
} from "./slide-spec.js";

const slides: readonly SlideSpec[] = [
  {
    index: 1,
    total: 5,
    template: "hero",
    headline: "Organize os cabos sem comprar nada",
    claims: [],
  },
  { index: 2, total: 5, template: "benefit", headline: "Agrupe os fios por uso", claims: [] },
  {
    index: 3,
    total: 5,
    template: "benefit",
    headline: "Prenda os cabos na lateral da mesa",
    claims: [],
  },
  { index: 4, total: 5, template: "benefit", headline: "Deixe a régua acessível", claims: [] },
  { index: 5, total: 5, template: "cta", headline: "Veja os detalhes da oferta", claims: [] },
];

describe("slide deck quality gate", () => {
  it("normalizes accents and blocks a generic first-slide hook", () => {
    expect(hasGenericHookOpener("Você não vai acreditar nisso")).toBe(true);
    expect(
      validateSlideDeckQuality([
        { ...slides[0]!, headline: "Ótima opção para você" },
        ...slides.slice(1),
      ]),
    ).toEqual({ ok: false, reason: "generic_hook" });
  });

  it("blocks repeated slide copy and allows distinct useful copy", () => {
    expect(
      validateSlideDeckQuality([
        slides[0]!,
        { ...slides[1]!, headline: "Agrupe os fios por uso" },
        { ...slides[2]!, headline: " AGRUPE OS FIOS, POR USO! " },
        ...slides.slice(3),
      ]),
    ).toEqual({ ok: false, reason: "repeated_slide_copy" });
    expect(validateSlideDeckQuality(slides)).toEqual({ ok: true });
  });
});

describe("validateSlideSpec sceneAssetId", () => {
  it("accepts uuid-like ids and rejects anything else", () => {
    const ok = "11111111-2222-4333-8444-555555555555";
    expect(validateSlideSpec({ ...slides[0]!, sceneAssetId: ok })).toEqual({ ok: true });
    expect(validateSlideSpec({ ...slides[0]!, sceneAssetId: "../x" })).toEqual({
      ok: false,
      reason: "scene_asset_invalid",
    });
    expect(validateSlideSpec({ ...slides[0]!, storySceneAssetId: "../x" })).toEqual({
      ok: false,
      reason: "scene_asset_invalid",
    });
  });
});
