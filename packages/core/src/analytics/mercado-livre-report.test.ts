import { describe, expect, it } from "vitest";
import { inspectMercadoLivreReport } from "./mercado-livre-report.js";

describe("Mercado Livre report schema discovery", () => {
  it("hashes and preserves the original bytes while leaving the report awaiting a real sample", () => {
    const bytes = new TextEncoder().encode("Venda,Data\nREDACTED,REDACTED\n");
    const result = inspectMercadoLivreReport({
      originalBytes: bytes,
      discoveredHeaders: ["Venda", "Data"],
    });

    expect(result).toMatchObject({
      status: "awaiting_real_sample",
      sha256: "d47d327618792aa71f14b31d50b886bf23584c416148a1c16c49be1b75f89f54",
      discoveredHeaders: ["Venda", "Data"],
      unknownHeaders: ["Venda", "Data"],
      mappingVersion: null,
      normalizedRows: [],
    });
    expect([...result.originalBytes]).toEqual([...bytes]);
  });

  it("rejects ambiguous duplicate headers without interpreting rows", () => {
    expect(
      inspectMercadoLivreReport({
        originalBytes: new TextEncoder().encode("a,a\n"),
        discoveredHeaders: [" Venda ", "venda"],
      }),
    ).toMatchObject({ status: "rejected", error: "ambiguous_headers" });
  });
});
