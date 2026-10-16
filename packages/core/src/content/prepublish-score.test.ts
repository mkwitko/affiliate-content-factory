import { describe, expect, it } from "vitest";
import type { ChannelKind } from "../channels/channel.js";
import { type PrepublishInput, scorePrepublish } from "./prepublish-score.js";

const base: PrepublishInput = { format: "reel_slides" };
const check = (input: PrepublishInput, id: string) =>
  scorePrepublish(input).checks.find((entry) => entry.id === id)?.result;

describe("scorePrepublish", () => {
  it("marks every unsupplied input n/a and passes with score 100", () => {
    const score = scorePrepublish(base);
    expect(score.checks.every((entry) => entry.result === "n/a")).toBe(true);
    expect(score).toMatchObject({ version: 2, score: 100, verdict: "pass" });
  });
  it("blocks a generic hook opener regardless of the rest of the score", () => {
    const score = scorePrepublish({
      ...base,
      hookText: "Confira esta oferta",
      productFirst: true,
      fidelityVerdict: "pass",
    });
    expect(score.verdict).toBe("block");
    expect(score.checks.find((entry) => entry.id === "hook_opener")?.result).toBe("fail");
  });
  it("grades hook timing pass and warn", () => {
    expect(
      check({ ...base, hookTiming: { firstCaptionMs: 200, firstSpokenMs: 1500 } }, "hook_timing"),
    ).toBe("pass");
    expect(
      check({ ...base, hookTiming: { firstCaptionMs: 200, firstSpokenMs: 2500 } }, "hook_timing"),
    ).toBe("warn");
  });
  it("checks the product-first rule only for slide reels and ai stories", () => {
    expect(check({ ...base, productFirst: false }, "product_first")).toBe("warn");
    expect(check({ format: "carousel", productFirst: false }, "product_first")).toBe("n/a");
  });
  it("checks the duration band per channel kind", () => {
    const at = (durationSec: number, channelKind: ChannelKind) =>
      check({ ...base, durationSec, channelKind }, "duration_band");
    expect(at(30, "instagram_reels")).toBe("pass");
    expect(at(90, "instagram_reels")).toBe("warn");
    expect(at(45, "youtube")).toBe("pass");
    expect(at(120, "youtube")).toBe("warn");
    expect(at(200, "youtube")).toBe("pass");
    expect(at(30, "tiktok_video")).toBe("n/a");
  });
  it("blocks a clipped caption, a stale price, and blocked fidelity or render QA", () => {
    expect(scorePrepublish({ ...base, captionClipped: true }).verdict).toBe("block");
    expect(
      scorePrepublish({ ...base, price: { shown: true, evidenceAgeDays: 40, maxAgeDays: 30 } })
        .verdict,
    ).toBe("block");
    expect(scorePrepublish({ ...base, fidelityVerdict: "block" }).verdict).toBe("block");
    expect(scorePrepublish({ ...base, renderVerdict: "block" }).verdict).toBe("block");
  });
  it("does not check price freshness when no price is shown", () => {
    expect(check({ ...base, price: { shown: false, maxAgeDays: 30 } }, "price_fresh")).toBe("n/a");
  });
  it("fails a missing CTA and passes a present one", () => {
    expect(check({ ...base, cta: { expected: "link na bio", copy: "Veja!" } }, "cta_present")).toBe(
      "warn",
    );
    expect(
      check(
        { ...base, cta: { expected: "Link na bio", copy: "veja o LINK NA BIO" } },
        "cta_present",
      ),
    ).toBe("pass");
  });
  it("warns below 60 and weighs warn as half", () => {
    const score = scorePrepublish({
      ...base,
      hookTiming: { firstCaptionMs: 900, firstSpokenMs: 3000 },
      productFirst: false,
      cta: { expected: "x", copy: "y" },
      fidelityVerdict: "warn",
    });
    expect(score.score).toBe(50);
    expect(score.verdict).toBe("warn");
  });
  it("skips video-only checks for a carousel", () => {
    expect(
      check({ format: "carousel", durationSec: 500, channelKind: "youtube" }, "duration_band"),
    ).toBe("n/a");
  });
});
