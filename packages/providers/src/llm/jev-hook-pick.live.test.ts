import { pickStrongestHook } from "@money-maker/core/decisions/hook-pick";
import { describe, expect, it } from "vitest";
import { createJevDecisionProvider } from "./jev-decision-provider.js";

// Real TypeSafe call: runs only with TYPESAFE_API_KEY and JEV_LIVE=1 (never in CI by accident).
const apiKey = process.env.TYPESAFE_API_KEY ?? "";
describe.skipIf(!apiKey || process.env.JEV_LIVE !== "1")("Jev hook pick (live)", () => {
  it("scores two pt-BR hooks with hook_strength", async () => {
    const pick = await pickStrongestHook(createJevDecisionProvider({ apiKey }), {
      hooks: ["Confira este cesto organizador", "Sua bancada livre em 5 minutos com um cesto"],
      niche: "Casa organizada",
      offerTitle: "Cesto organizador de bambu com tampa",
      verifiedFacts: [{ key: "current_price", value: { amountMinor: 8990, currency: "BRL" } }],
    });
    console.info("jev_live_hook_pick", JSON.stringify(pick));
    expect(pick.status).not.toBe("unavailable");
  }, 30_000);
});
