import { describe, expect, it } from "vitest";
import { countPrompts } from "./count-probe.js";

describe("count probe prompts", () => {
  it("asks for the same key under every prompt and keeps the production prompt as control", () => {
    const prompts = countPrompts("shelves", "Estante 3 Prateleiras");
    expect(prompts.production.withReference).toBe(true);
    for (const variant of Object.values(prompts))
      if (variant !== prompts.production) expect(variant.prompt).toContain('"shelves"');
  });
});
