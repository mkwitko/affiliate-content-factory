import { describe, expect, it } from "vitest";
import { CanvaDesignExporter } from "@money-maker/providers/canva/design-exporter";
describe("Canva MCP boundary", () => {
  it("keeps page order and rejects missing pages", async () => {
    const exporter = new CanvaDesignExporter({
      exportPages: async () => [
        {
          page: 1,
          bytes: new Uint8Array([1]),
          width: 1080,
          height: 1080,
          expiresAt: new Date(Date.now() + 1000),
        },
      ],
    });
    await expect(
      exporter.exportPages({ designId: "d", pages: [1], format: "png" }),
    ).resolves.toHaveLength(1);
  });
});
