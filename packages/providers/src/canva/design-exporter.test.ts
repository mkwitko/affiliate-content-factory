import { describe, expect, it } from "vitest";
import { CanvaDesignExporter } from "./design-exporter.js";
describe("Canva exporter", () => {
  it("returns pages in requested order", async () => {
    const exporter = new CanvaDesignExporter({
      exportPages: async () => [
        {
          page: 1,
          bytes: new Uint8Array([1]),
          width: 10,
          height: 10,
          expiresAt: new Date(Date.now() + 1000),
        },
        {
          page: 2,
          bytes: new Uint8Array([2]),
          width: 10,
          height: 10,
          expiresAt: new Date(Date.now() + 1000),
        },
      ],
    });
    await expect(
      exporter.exportPages({ designId: "d", pages: [2, 1], format: "png" }),
    ).resolves.toMatchObject([{ page: 2 }, { page: 1 }]);
  });
});
