import { describe, expect, it } from "vitest";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createRedirect,
  resolveTrackedRedirect,
  trackedUrl,
  visitorHash,
  withOfficialLink,
} from "./attribution.js";
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-24T12:00:00Z");
describe("attribution", () => {
  it("uses opaque HTTPS redirects", () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://produto.mercadolivre.com.br/affiliate-destination"),
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(resolveTrackedRedirect(record)).toEqual({
      url: new URL("https://produto.mercadolivre.com.br/affiliate-destination"),
      expired: false,
    });
    expect(() =>
      createRedirect({ ...record, destination: new URL("javascript:alert(1)") }),
    ).toThrow("destination_not_allowed");
  });
  it("keeps the variant and offer the link belongs to", () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(now.getTime() + 1000),
      contentVariantId: "v1",
      offerId: "o1",
      fallback: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    });
    expect(record).toMatchObject({
      contentVariantId: "v1",
      offerId: "o1",
      fallbackUrl: "https://www.mercadolivre.com.br/p/MLB1",
    });
  });
  it("keeps the publication attempt identity on the redirect", () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(now.getTime() + 1000),
      contentVariantId: "v1",
      publicationAttemptId: "attempt-1",
    });
    expect(record.publicationAttemptId).toBe("attempt-1");
  });
  it("accepts only names that can identify an existing Mercado Livre label", () => {
    expect(() =>
      createRedirect({
        workspaceId,
        destination: new URL("https://meli.la/abc"),
        expiresAt: new Date(now.getTime() + 1000),
        marketplaceLabel: "instagram_casa-1",
      }),
    ).not.toThrow();
    for (const marketplaceLabel of ["Instagram Casa", "Upper", "x".repeat(31), "a.b"]) {
      expect(() =>
        createRedirect({
          workspaceId,
          destination: new URL("https://meli.la/abc"),
          expiresAt: new Date(now.getTime() + 1000),
          marketplaceLabel,
        }),
      ).toThrow("invalid_marketplace_label");
    }
  });
  it("sends an expired or altered link to the listing instead of dead-ending a live post", () => {
    const record = createRedirect({
      workspaceId,
      destination: new URL("https://meli.la/abc"),
      expiresAt: new Date(now.getTime() - 1),
      fallback: new URL("https://www.mercadolivre.com.br/p/MLB1"),
    });
    expect(resolveTrackedRedirect(record, now)).toEqual({
      url: new URL("https://www.mercadolivre.com.br/p/MLB1"),
      expired: true,
    });
    const altered = {
      ...record,
      expiresAt: new Date(now.getTime() + 1000),
      destination: "https://evil.example/",
    };
    expect(resolveTrackedRedirect(altered, now).url.toString()).toBe(
      "https://www.mercadolivre.com.br/p/MLB1",
    );
    const { fallbackUrl: _dropped, ...withoutFallback } = record;
    expect(() => resolveTrackedRedirect(withoutFallback, now)).toThrow("tracking_expired");
  });
  it("hashes visitors per day so a click counts once without identifying the visitor", () => {
    const first = visitorHash({ salt: "s", ip: "1.2.3.4", userAgent: "ua", now });
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorHash({ salt: "s", ip: "1.2.3.4", userAgent: "ua", now })).toBe(first);
    expect(
      visitorHash({
        salt: "s",
        ip: "1.2.3.4",
        userAgent: "ua",
        now: new Date("2026-09-25T12:00:00Z"),
      }),
    ).not.toBe(first);
    expect(visitorHash({ salt: "other", ip: "1.2.3.4", userAgent: "ua", now })).not.toBe(first);
  });
  it("builds the public bio link", () => {
    const url = trackedUrl("https://mcp.example.com/", "abc");
    expect(url).toBe("https://mcp.example.com/go/abc");
  });
  it("puts the official affiliate URL in a caption placeholder", () => {
    expect(withOfficialLink("Veja {link} #publi", "https://meli.la/abc")).toBe(
      "Veja https://meli.la/abc #publi",
    );
  });
  it("rewrites an old tracked link copied from an earlier variant", () => {
    expect(
      withOfficialLink(
        "Toque no link\nhttps://mcp.example.com/go/OLDslug_-1",
        "https://meli.la/abc",
        "https://mcp.example.com/",
      ),
    ).toBe("Toque no link\nhttps://meli.la/abc");
  });
});
