import { describe, expect, it } from "vitest";
import { suggestInstagramHandle } from "./suggest-instagram-handle.js";

describe("suggestInstagramHandle", () => {
  it.each([
    ["Example Shop Beleza", "exampleshop.beleza"],
    ["Example Shop Home", "exampleshop.home"],
    ["Example Shop Tech", "exampleshop.tech"],
    ["Cozinha Prática", "cozinha.pratica"],
    ["Pets", "pets"],
  ])("suggests %s -> %s", (name, handle) => {
    expect(suggestInstagramHandle(name)).toBe(handle);
  });
});
