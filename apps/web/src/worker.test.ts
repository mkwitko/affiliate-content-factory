import { describe, expect, it } from "vitest";
import { handleRequest, type WebWorkerEnv } from "./worker.js";

const environment = (assetsResponse: Response): WebWorkerEnv => ({
  ASSETS: {
    fetch: async () => assetsResponse,
  },
});

describe("web Worker request routing", () => {
  it("proxies authenticated API requests to the Money Maker API origin", async () => {
    let forwardedRequest: Request | undefined;
    const request = new Request("https://example.com/v1/auth/logout?return=home", {
      method: "POST",
      headers: {
        cookie: "mm_session=session-token",
        origin: "https://example.com",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reason: "operator_requested" }),
    });

    const response = await handleRequest(
      request,
      environment(new Response("static")),
      async (upstreamRequest) => {
        forwardedRequest = upstreamRequest;
        return new Response(null, {
          status: 204,
          headers: { "set-cookie": "mm_session=; Max-Age=0; Path=/" },
        });
      },
    );

    expect(response.status).toBe(204);
    expect(forwardedRequest?.url).toBe("https://mcp.example.com/v1/auth/logout?return=home");
    expect(forwardedRequest?.method).toBe("POST");
    expect(forwardedRequest?.headers.get("cookie")).toBe("mm_session=session-token");
    expect(forwardedRequest?.headers.get("origin")).toBe("https://example.com");
    expect(await forwardedRequest?.text()).toContain("operator_requested");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each(["/go/abc123?src=bio", "/go/n/exampleshoptech"])(
    "proxies tracked links at %s so they resolve on the public domain",
    async (path) => {
      let forwardedUrl: string | undefined;
      await handleRequest(
        new Request(`https://example.com${path}`),
        environment(new Response("static")),
        async (upstreamRequest) => {
          forwardedUrl = upstreamRequest.url;
          return new Response(null, { status: 302 });
        },
      );

      expect(forwardedUrl).toBe(`https://mcp.example.com${path}`);
    },
  );

  it("serves frontend assets without forwarding non-API routes", async () => {
    let upstreamCalled = false;
    const response = await handleRequest(
      new Request("https://example.com/invitations/invite-token"),
      environment(new Response("react-app", { status: 200 })),
      async () => {
        upstreamCalled = true;
        return new Response("unexpected");
      },
    );

    expect(await response.text()).toBe("react-app");
    expect(upstreamCalled).toBe(false);
  });

  it("serves the SPA fallback when deployed without a Cloudflare assets binding", async () => {
    const response = await handleRequest(
      new Request("https://example.com/invitations/invite-token"),
      {
        ASSET_CONTENT: {
          "/index.html": { body: "inline-react-app", contentType: "text/html" },
        },
      } as WebWorkerEnv,
      async () => new Response("unexpected"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("inline-react-app");
  });

  it.each(["/", "/invitations/invite-token", "/index.html"])(
    "never lets browsers cache the HTML shell at %s",
    async (path) => {
      const response = await handleRequest(
        new Request(`https://example.com${path}`),
        {
          ASSET_CONTENT: {
            "/index.html": { body: "inline-react-app", contentType: "text/html" },
          },
        } as WebWorkerEnv,
        async () => new Response("unexpected"),
      );

      expect(response.headers.get("cache-control")).toBe("no-cache");
    },
  );

  it("caches hashed build assets for a year", async () => {
    const response = await handleRequest(
      new Request("https://example.com/assets/index-abc123.js"),
      {
        ASSET_CONTENT: {
          "/assets/index-abc123.js": { body: "js", contentType: "text/javascript" },
        },
      } as WebWorkerEnv,
      async () => new Response("unexpected"),
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
