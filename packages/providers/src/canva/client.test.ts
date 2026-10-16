import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { CanvaExportError, createCanvaClient } from "./client.js";

const png = async (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Canva HTTP client", () => {
  it("creates an export job, polls until success, and downloads the pages", async () => {
    const bytes = await png(200, 100);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/exports") {
        return jsonResponse({ job: { id: "job-1" } });
      }
      if (url === "https://api.canva.com/rest/v1/exports/job-1") {
        return jsonResponse({
          job: {
            id: "job-1",
            status: "success",
            urls: ["https://export-download.canva.com/page-1.png"],
          },
        });
      }
      if (url === "https://export-download.canva.com/page-1.png") {
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = createCanvaClient({ accessToken: "token-1", fetcher });
    const pages = await client.exportPages({ designId: "design-1", pages: [1], format: "png" });

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, width: 200, height: 100 });
  });

  it("polls until the job succeeds using the injected sleep", async () => {
    const bytes = await png(10, 10);
    let pollCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/exports")
        return jsonResponse({ job: { id: "job-1" } });
      if (url === "https://api.canva.com/rest/v1/exports/job-1") {
        pollCount += 1;
        if (pollCount < 3) return jsonResponse({ job: { id: "job-1", status: "in_progress" } });
        return jsonResponse({
          job: {
            id: "job-1",
            status: "success",
            urls: ["https://export-download.canva.com/page-1.png"],
          },
        });
      }
      if (url === "https://export-download.canva.com/page-1.png") {
        return new Response(bytes, { headers: { "content-type": "image/png" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const sleep = vi.fn(async () => undefined);

    const client = createCanvaClient({ accessToken: "token-1", fetcher, sleep });
    await client.exportPages({ designId: "design-1", pages: [1], format: "png" });

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(pollCount).toBe(3);
  });

  it("throws when the export job fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/exports")
        return jsonResponse({ job: { id: "job-1" } });
      return jsonResponse({
        job: { id: "job-1", status: "failed", error: { code: "license_required", message: "no" } },
      });
    });

    const client = createCanvaClient({ accessToken: "token-1", fetcher });
    await expect(
      client.exportPages({ designId: "design-1", pages: [1], format: "png" }),
    ).rejects.toThrow("license_required");
  });

  it.each([
    ["creating", "https://api.canva.com/rest/v1/exports"],
    ["polling", "https://api.canva.com/rest/v1/exports/job-1"],
  ])("reports a 401 while %s the export as canva_token_invalid", async (_step, rejectedUrl) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === rejectedUrl) return jsonResponse({ code: "invalid_access_token" }, 401);
      return jsonResponse({ job: { id: "job-1" } });
    });

    const client = createCanvaClient({ accessToken: "revoked-token", fetcher });
    await expect(
      client.exportPages({ designId: "design-1", pages: [1], format: "png" }),
    ).rejects.toThrow(new CanvaExportError("canva_token_invalid"));
  });

  it("gives up after the bounded poll instead of waiting forever", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "https://api.canva.com/rest/v1/exports")
        return jsonResponse({ job: { id: "job-1" } });
      return jsonResponse({ job: { id: "job-1", status: "in_progress" } });
    });
    const sleep = vi.fn(async () => undefined);

    const client = createCanvaClient({ accessToken: "token-1", fetcher, sleep });
    await expect(
      client.exportPages({ designId: "design-1", pages: [1], format: "png" }),
    ).rejects.toBeInstanceOf(CanvaExportError);
  });
});
