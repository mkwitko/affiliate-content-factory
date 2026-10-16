import { describe, expect, it } from "vitest";
import { readVideoMarkPlan } from "./video-mark.js";

const ctx = (videoMark: unknown, brandKit: unknown = { logoLightAssetId: "logo-1" }) => ({
  context: { videoMark, brandKit },
});

describe("readVideoMarkPlan", () => {
  it("is off by default, without logos, or when disabled", () => {
    expect(readVideoMarkPlan(null)).toBeUndefined();
    expect(readVideoMarkPlan({ context: { brandKit: { logoLightAssetId: "x" } } })).toBeUndefined();
    expect(readVideoMarkPlan(ctx({ enabled: false }))).toBeUndefined();
    expect(readVideoMarkPlan(ctx({ enabled: true }, {}))).toBeUndefined();
  });

  it("uses brand kit position unless the mark overrides it, and defaults opacity", () => {
    expect(readVideoMarkPlan(ctx({ enabled: true }))).toMatchObject({
      opacity: 0.7,
      position: "top-left",
      minWidth: 160,
      logoLightAssetId: "logo-1",
    });
    expect(
      readVideoMarkPlan(ctx({ enabled: true, opacity: 0.5, position: "bottom-left" })),
    ).toMatchObject({ opacity: 0.5, position: "bottom-left" });
    expect(readVideoMarkPlan(ctx({ enabled: true, opacity: 2 }))?.opacity).toBe(0.7);
  });
});
