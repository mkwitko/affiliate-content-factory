import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvalidInvitationRoute } from "./invitations.$token.js";
import { resolveRoute } from "./route-parser.js";

describe("resolveRoute", () => {
  it("returns a safe invalid-invitation route for malformed encoded tokens", () => {
    expect(resolveRoute("/invitations/%E0%A4%A")).toEqual({ kind: "invalid_invitation" });
  });

  it("decodes a valid invitation token", () => {
    expect(resolveRoute("/invitations/token%2Fwith%2Fslashes")).toEqual({
      kind: "invitation",
      token: "token/with/slashes",
    });
  });

  it("resolves a niche storefront route", () => {
    expect(resolveRoute("/n/tech-ab12")).toEqual({ kind: "storefront", slug: "tech-ab12" });
    expect(resolveRoute("/n/tech-ab12/")).toEqual({ kind: "storefront", slug: "tech-ab12" });
  });

  it("resolves panel sections before short storefront URLs", () => {
    expect(resolveRoute("/ofertas")).toEqual({ kind: "panel", section: "ofertas" });
    expect(resolveRoute("/Resultados/")).toEqual({ kind: "panel", section: "resultados" });
    expect(resolveRoute("/links")).toEqual({ kind: "panel", section: "links" });
    expect(resolveRoute("/revisar")).toEqual({ kind: "panel", section: "revisar" });
  });

  it("resolves a single-segment short URL to the niche storefront", () => {
    expect(resolveRoute("/exampleshoptech")).toEqual({
      kind: "storefront",
      slug: "exampleshoptech",
    });
    expect(resolveRoute("/exampleshopcasa/")).toEqual({
      kind: "storefront",
      slug: "exampleshopcasa",
    });
  });

  it.each([
    "/",
    "",
    "/invitations",
    "/n",
    "/v1",
    "/health",
    "/go",
    "/assets",
    "/index.html",
    "/favicon.ico",
    "/a/b",
  ])("keeps the reserved or non-slug path %s on the dashboard", (path) => {
    expect(resolveRoute(path)).toEqual({ kind: "home" });
  });

  it("renders a safe recovery message for an invalid invitation link", () => {
    expect(renderToStaticMarkup(<InvalidInvitationRoute />)).toContain(
      "Este link de convite é inválido",
    );
  });
});
