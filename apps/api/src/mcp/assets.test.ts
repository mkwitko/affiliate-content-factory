import { describe, expect, it } from "vitest";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
describe("asset MCP safety boundary", () => {
  it("rejects private media destinations", async () => {
    await expect(
      fetchSafeMedia(new URL("https://169.254.169.254/latest/meta-data"), {
        maxBytes: 10,
        allowedMimeTypes: ["image/png"],
      }),
    ).rejects.toThrow("url_not_public");
  });
});
