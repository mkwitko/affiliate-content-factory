import { describe, expect, it } from "vitest";
import { createModelStreak } from "./model-streak.js";

describe("createModelStreak", () => {
  it("prefers the loaded model for a streak, then lets the oldest job decide once", () => {
    const prefer = createModelStreak(3);
    expect([1, 2, 3].map(() => prefer("t1", "image_editing"))).toEqual([
      "image_editing",
      "image_editing",
      "image_editing",
    ]);
    expect(prefer("t1", "image_editing")).toBeUndefined();
    expect(prefer("t1", "image_editing")).toBe("image_editing");
  });

  it("restarts the count when the loaded model changes and keeps tokens apart", () => {
    const prefer = createModelStreak(2);
    prefer("t1", "image_editing");
    prefer("t1", "image_editing");
    expect(prefer("t1", "visual_qa")).toBe("visual_qa");
    expect(prefer("t2", "image_editing")).toBe("image_editing");
    expect(prefer("t1", undefined)).toBeUndefined();
  });
});
