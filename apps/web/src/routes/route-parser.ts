export const panelSections = [
  "revisar",
  "links",
  "conteudos",
  "ofertas",
  "nichos",
  "resultados",
  "integracoes",
] as const;

export type PanelSection = (typeof panelSections)[number];

export type WebRoute =
  | Readonly<{ kind: "home" }>
  | Readonly<{ kind: "panel"; section: PanelSection }>
  | Readonly<{ kind: "invitation"; token: string }>
  | Readonly<{ kind: "invalid_invitation" }>
  | Readonly<{ kind: "storefront"; slug: string }>;

/** First path segments the app, API, or static assets already own; never a niche short URL. */
const reservedSegments = new Set(["invitations", "n", "v1", "health", "go", "assets"]);

const isPanelSection = (value: string): value is PanelSection =>
  (panelSections as readonly string[]).includes(value);

export const resolveRoute = (pathname: string): WebRoute => {
  const storefront = pathname.match(/^\/n\/([^/]+)\/?$/);
  if (storefront?.[1]) return { kind: "storefront", slug: storefront[1] };

  // Panel sections claim their segment before the short bio URL fallback below.
  const first = pathname.match(/^\/([a-z0-9][a-z0-9-]*)\/?$/i)?.[1];
  if (first && isPanelSection(first.toLowerCase()))
    return { kind: "panel", section: first.toLowerCase() as PanelSection };

  // Short bio URL, e.g. /exampleshoptech. Slugs have no dots, so /favicon.ico stays out.
  if (first && !reservedSegments.has(first.toLowerCase()))
    return { kind: "storefront", slug: first };

  const match = pathname.match(/^\/invitations\/([^/]+)\/?$/);
  if (!match?.[1]) return { kind: "home" };

  try {
    return { kind: "invitation", token: decodeURIComponent(match[1]) };
  } catch {
    return { kind: "invalid_invitation" };
  }
};
