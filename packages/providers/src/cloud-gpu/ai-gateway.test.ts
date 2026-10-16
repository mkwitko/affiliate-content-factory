import { describe, expect, it } from "vitest";
import { aiGatewayCredits } from "./ai-gateway.js";

const reply = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("aiGatewayCredits", () => {
  it("reads the prepaid balance, refuses a rejected key and fails on anything else", async () => {
    expect(
      await aiGatewayCredits("k", reply(200, { balance: "9.91", total_used: "25.08" })),
    ).toEqual({ balanceUsd: 9.91, usedUsd: 25.08 });
    expect(await aiGatewayCredits("k", reply(401, {}))).toBe("invalid");
    await expect(aiGatewayCredits("k", reply(500, {}))).rejects.toThrow("ai_gateway_credits_500");
    await expect(aiGatewayCredits("k", reply(200, { balance: "x" }))).rejects.toThrow(
      "ai_gateway_credits_invalid",
    );
  });
});
