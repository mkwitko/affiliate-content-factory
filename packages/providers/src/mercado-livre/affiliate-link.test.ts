import { describe, expect, it } from "vitest";
import { isMercadoLivreAffiliateHost, resolveAffiliateLink } from "./affiliate-link.js";

const redirectTo = (location: string) =>
  ({ status: 302, headers: new Headers({ location }), ok: false }) as unknown as Response;
const page = () => ({ status: 200, headers: new Headers(), ok: true }) as unknown as Response;

describe("affiliate link host allowlist", () => {
  it("accepts Mercado Livre and meli.la hosts only", () => {
    expect(isMercadoLivreAffiliateHost("mercadolivre.com")).toBe(true);
    expect(isMercadoLivreAffiliateHost("www.mercadolivre.com")).toBe(true);
    expect(isMercadoLivreAffiliateHost("meli.la")).toBe(true);
    expect(isMercadoLivreAffiliateHost("produto.mercadolivre.com.br")).toBe(true);
    expect(isMercadoLivreAffiliateHost("mercadolivre.com.br.evil.com")).toBe(false);
    expect(isMercadoLivreAffiliateHost("evilmercadolivre.com.br")).toBe(false);
    expect(isMercadoLivreAffiliateHost("example.com")).toBe(false);
  });
});

describe("resolveAffiliateLink", () => {
  it("reads the featured product of the affiliate social page links now land on", async () => {
    const html =
      '<div class="ui-ms-profile"><a href="https://www.mercadolivre.com.br/x/p/MLB111">header</a></div>' +
      '<div class="rl-card-featured-wrapper"><section class="rl-card-featured">' +
      '<a href="https://www.mercadolivre.com.br/echo-dot/p/MLB19795010?matt_tool=1">Echo</a></section></div>' +
      '<section class="rl-list"><a href="https://www.mercadolivre.com.br/outro/p/MLB222">outro</a></section>';
    const agents: string[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      return String(input) === "https://meli.la/2vz8GZS"
        ? redirectTo("https://www.mercadolivre.com.br/social/affiliate-handle?matt_word=affiliate-handle&ref=abc")
        : new Response(html, { status: 200 });
    }) as unknown as typeof fetch;
    const result = await resolveAffiliateLink(new URL("https://meli.la/2vz8GZS"), fetcher);
    expect(result.productId).toBe("MLB19795010");
    expect(result.finalUrl?.pathname).toBe("/social/affiliate-handle");
    expect(agents.every((agent) => agent.includes("AffiliateContentFactoryLinkCheck"))).toBe(true);
  });

  it("returns null for a social page without a featured product", async () => {
    const fetcher = (async (input: URL | RequestInfo) =>
      String(input) === "https://meli.la/s"
        ? redirectTo("https://www.mercadolivre.com.br/social/affiliate-handle")
        : new Response('<a href="/p/MLB222">sem destaque</a>', {
            status: 200,
          })) as unknown as typeof fetch;
    expect(
      (await resolveAffiliateLink(new URL("https://meli.la/s"), fetcher)).productId,
    ).toBeNull();
  });

  it("follows redirects to a catalog product page", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      const url = String(input);
      seen.push(url);
      return url === "https://meli.la/abc"
        ? redirectTo("https://www.mercadolivre.com.br/notebook-stand/p/MLB123456?pdp_filters=x")
        : page();
    }) as unknown as typeof fetch;
    const result = await resolveAffiliateLink(new URL("https://meli.la/abc"), fetcher);
    expect(result.productId).toBe("MLB123456");
    expect(seen).toEqual(["https://meli.la/abc"]);
  });

  it("returns null for an item page without a catalog product", async () => {
    const fetcher = (async (input: URL | RequestInfo) =>
      String(input) === "https://meli.la/item"
        ? redirectTo("https://produto.mercadolivre.com.br/MLB-987-suporte-_JM")
        : page()) as unknown as typeof fetch;
    const result = await resolveAffiliateLink(new URL("https://meli.la/item"), fetcher);
    expect(result.productId).toBeNull();
    expect(result.finalUrl?.hostname).toBe("produto.mercadolivre.com.br");
  });

  it("stops at a hop outside the allowlist without fetching it", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return redirectTo("https://tracker.example.com/x");
    }) as unknown as typeof fetch;
    const result = await resolveAffiliateLink(new URL("https://meli.la/t"), fetcher);
    expect(result.productId).toBeNull();
    expect(seen).toEqual(["https://meli.la/t"]);
  });

  it("gives up after five hops", async () => {
    let hop = 0;
    const fetcher = (async () => redirectTo(`https://meli.la/${++hop}`)) as unknown as typeof fetch;
    const result = await resolveAffiliateLink(new URL("https://meli.la/0"), fetcher);
    expect(result.productId).toBeNull();
    expect(hop).toBe(5);
  });

  it("rejects a non-allowlisted or non-https start URL without fetching", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return page();
    }) as unknown as typeof fetch;
    await expect(resolveAffiliateLink(new URL("https://example.com/x"), fetcher)).resolves.toEqual({
      productId: null,
      finalUrl: null,
    });
    await expect(resolveAffiliateLink(new URL("http://meli.la/x"), fetcher)).resolves.toEqual({
      productId: null,
      finalUrl: null,
    });
    expect(called).toBe(false);
  });

  it("reports a network failure separately from an unresolved link", async () => {
    const fetcher = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    await expect(resolveAffiliateLink(new URL("https://meli.la/x"), fetcher)).resolves.toEqual({
      productId: null,
      finalUrl: null,
      failure: "network",
    });
  });

  it("refuses explicit ports and credentials at the start and on every hop", async () => {
    const seen: string[] = [];
    const fetcher = (async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return String(input) === "https://meli.la/ok"
        ? redirectTo("https://x.mercadolivre.com.br:22/p/MLB1")
        : page();
    }) as unknown as typeof fetch;
    for (const start of ["https://meli.la:8443/x", "https://user:pass@meli.la/x"]) {
      await expect(resolveAffiliateLink(new URL(start), fetcher)).resolves.toEqual({
        productId: null,
        finalUrl: null,
      });
    }
    const hop = await resolveAffiliateLink(new URL("https://meli.la/ok"), fetcher);
    expect(hop.productId).toBeNull();
    expect(seen).toEqual(["https://meli.la/ok"]);
  });
});
