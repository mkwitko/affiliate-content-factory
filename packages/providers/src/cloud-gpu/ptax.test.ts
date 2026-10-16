import { describe, expect, it } from "vitest";
import { fetchPtaxUsdBrl } from "./ptax.js";

const reply = (value: unknown[]) =>
  new Response(JSON.stringify({ value }), { headers: { "content-type": "application/json" } });

describe("fetchPtaxUsdBrl", () => {
  it("walks back over a weekend to the last published selling rate", async () => {
    const asked: string[] = [];
    const rate = await fetchPtaxUsdBrl(new Date("2026-10-11T15:00:00Z"), async (url) => {
      asked.push(String(url));
      return String(url).includes("'10-09-2026'")
        ? reply([
            {
              cotacaoCompra: 4.9886,
              cotacaoVenda: 4.9892,
              dataHoraCotacao: "2026-10-09 13:07:30.746597",
            },
          ])
        : reply([]);
    });
    expect(asked).toHaveLength(3);
    expect(rate).toEqual({
      brlPerUsd: 4.9892,
      source: "bcb-ptax-venda:10-09-2026",
      at: new Date("2026-10-09T16:07:30Z"),
    });
  });

  it("fails closed on an error, an absurd rate or no rate in five days", async () => {
    expect(
      await fetchPtaxUsdBrl(new Date(), async () => new Response("", { status: 503 })),
    ).toBeNull();
    expect(
      await fetchPtaxUsdBrl(new Date(), async () =>
        reply([{ cotacaoVenda: 0, dataHoraCotacao: "2026-10-09 13:07:30" }]),
      ),
    ).toBeNull();
    expect(await fetchPtaxUsdBrl(new Date(), async () => reply([]))).toBeNull();
    expect(
      await fetchPtaxUsdBrl(new Date(), async () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }),
    ).toBeNull();
  });
});
