import { describe, expect, it } from "vitest";
import { parsePlateCheck } from "./plate-check.js";

describe("parsePlateCheck", () => {
  it("is clean only when nothing forbidden is seen", () => {
    expect(parsePlateCheck({ text: false, person: false, product: false })?.clean).toBe(true);
    expect(parsePlateCheck({ text: true, person: false, product: false })?.clean).toBe(false);
  });

  it("refuses answers outside the schema", () => {
    expect(parsePlateCheck({ text: "no", person: false, product: false })).toBeNull();
    expect(parsePlateCheck(null)).toBeNull();
  });
});
