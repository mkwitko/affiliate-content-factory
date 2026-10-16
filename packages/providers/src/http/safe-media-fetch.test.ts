import { describe, expect, it } from "vitest";
import { fetchSafeMedia } from "./safe-media-fetch.js";
const limits = { maxBytes: 100, allowedMimeTypes: ["image/png"] };
describe("safe media fetch", () => {
  it.each([
    "https://127.0.0.1/a.png",
    "https://169.254.169.254/a.png",
    "https://[::1]/a.png",
    "https://10.0.0.1/a.png",
  ])("rejects private URL %s", async (url) => {
    await expect(fetchSafeMedia(new URL(url), limits)).rejects.toThrow("url_not_public");
  });
  it("caps bytes and MIME", async () => {
    const fetcher = async () =>
      ({
        ok: true,
        headers: new Headers({ "content-type": "image/png", "content-length": "101" }),
        arrayBuffer: async () => new ArrayBuffer(101),
      }) as Response;
    await expect(
      fetchSafeMedia(new URL("https://public.example/a.png"), limits, fetcher),
    ).rejects.toThrow("media_too_large");
  });
});
