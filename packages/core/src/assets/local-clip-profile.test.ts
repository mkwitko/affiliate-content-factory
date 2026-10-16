import { describe, expect, it } from "vitest";
import { isLocalClipProfile, localClipProfile } from "./local-clip-profile.js";

describe("localClipProfile", () => {
  it("picks size by canvas and frames by duration, capped at 33", () => {
    expect(localClipProfile({ canvas: "landscape", seconds: 1 })).toMatchObject({
      width: 832,
      height: 480,
      frames: 17,
      fps: 16,
    });
    expect(localClipProfile({ canvas: "portrait", seconds: 1.5 })).toMatchObject({
      width: 480,
      height: 832,
      frames: 25,
    });
    expect(localClipProfile({ canvas: "portrait", seconds: 12 })?.frames).toBe(33);
  });

  it("honours the frame cap and refuses when none fits", () => {
    expect(localClipProfile({ canvas: "landscape", seconds: 12, maxFrames: 25 })?.frames).toBe(25);
    expect(localClipProfile({ canvas: "landscape", seconds: 12, maxFrames: 10 })).toBeNull();
  });

  it("caps steps at 20", () => {
    expect(localClipProfile({ canvas: "landscape", seconds: 2, steps: 80 })?.steps).toBe(20);
  });

  it("rejects profiles the server would never issue", () => {
    const ok = localClipProfile({ canvas: "landscape", seconds: 2 });
    if (!ok) throw new Error("profile");
    expect(isLocalClipProfile(ok)).toBe(true);
    expect(isLocalClipProfile({ ...ok, frames: 49 as never })).toBe(false);
    expect(isLocalClipProfile({ ...ok, width: 1280 })).toBe(false);
    expect(isLocalClipProfile({ ...ok, steps: 21 })).toBe(false);
  });
});
