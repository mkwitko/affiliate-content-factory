import { describe, expect, it } from "vitest";
import { CANVASES, templateFor, validateSlideSpec } from "./templates.js";

const ids = ["hero", "benefit", "proof", "review", "price", "cta"] as const;

describe("creative templates", () => {
  it("defines every template on both canvases with zones inside the safe frame", () => {
    for (const id of ids) {
      for (const canvas of ["feed", "story"] as const) {
        const template = templateFor(id, canvas);
        expect(template.canvas).toEqual(CANVASES[canvas]);
        for (const zone of [
          template.productZone,
          template.headlineZone,
          template.markZone,
          template.slideNumberZone,
          template.bodyZone,
          template.badgeZone,
        ]) {
          if (!zone) continue;
          expect(zone.x).toBeGreaterThanOrEqual(0.04);
          expect(zone.y).toBeGreaterThanOrEqual(0.04);
          expect(zone.x + zone.w).toBeLessThanOrEqual(0.96);
          expect(zone.y + zone.h).toBeLessThanOrEqual(0.96);
        }
        expect(template.version).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("keeps story CTAs above the bottom sticker band", () => {
    const template = templateFor("cta", "story");
    expect(template.headlineZone.y + template.headlineZone.h).toBeLessThanOrEqual(0.8);
    expect(template.badgeZone?.y).toBeLessThan(0.8);
  });

  it("validates headline, body and badge limits", () => {
    const base = { index: 1, total: 6, template: "hero" as const, claims: [] };
    expect(validateSlideSpec({ ...base, headline: "" })).toEqual({
      ok: false,
      reason: "headline_missing",
    });
    expect(validateSlideSpec({ ...base, headline: "x".repeat(61) })).toEqual({
      ok: false,
      reason: "headline_too_long",
    });
    expect(validateSlideSpec({ ...base, headline: "x", body: "x".repeat(141) })).toEqual({
      ok: false,
      reason: "body_too_long",
    });
    expect(validateSlideSpec({ ...base, headline: "x", badge: "x".repeat(41) })).toEqual({
      ok: false,
      reason: "badge_too_long",
    });
    expect(
      validateSlideSpec({
        ...base,
        headline: "Seu notebook na altura certa",
        body: "Dobra e cabe na mochila",
      }),
    ).toEqual({ ok: true });
  });
});
