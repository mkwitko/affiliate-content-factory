import { privateHost } from "../http/safe-media-fetch.js";

const exactHosts = new Set([
  "mercadolivre.com",
  "www.mercadolivre.com",
  "mercadolivre.com.br",
  "meli.la",
]);

/** Hosts an operator-supplied affiliate link may use: Mercado Livre and its meli.la short links. */
export const isMercadoLivreAffiliateHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  return exactHosts.has(host) || host.endsWith(".mercadolivre.com.br");
};

export type ResolvedAffiliateLink =
  | Readonly<{ productId: string; finalUrl: URL }>
  | Readonly<{ productId: null; finalUrl: URL | null; failure?: "network" }>;

export type AffiliateLinkResolver = (url: URL) => Promise<ResolvedAffiliateLink>;

const maxHops = 5;
const totalTimeoutMs = 10_000;
/** meli.la answers 403 to a request with no user agent (2026-10-15). */
const userAgent = "Mozilla/5.0 (compatible; AffiliateContentFactoryLinkCheck/1.0; +https://example.com)";
const productPattern = /\/p\/(MLB\d+)/;
/** Since 2026-10, meli.la links land on the affiliate's social page with the product featured. */
const socialPath = /^\/social\/[^/]+\/?$/;
const featuredMarker = "rl-card-featured";
const maxSocialPageBytes = 1_500_000;

/** The first catalog product inside the featured card; null when the page has none. */
const featuredProduct = (html: string): string | null => {
  const start = html.indexOf(featuredMarker);
  if (start < 0) return null;
  return productPattern.exec(html.slice(start, start + 20_000))?.[1] ?? null;
};

const boundedText = async (response: Response): Promise<string | null> => {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxSocialPageBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(part.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const allowed = (url: URL) =>
  url.protocol === "https:" &&
  url.port === "" &&
  url.username === "" &&
  url.password === "" &&
  isMercadoLivreAffiliateHost(url.hostname) &&
  !privateHost(url.hostname);

/**
 * Follows an affiliate short link to a catalog product (/p/MLB…) without leaving Mercado Livre.
 * Reads status and Location headers; the body only of the affiliate social page, size-bounded,
 * to find its featured product.
 */
export const resolveAffiliateLink = async (
  start: URL,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedAffiliateLink> => {
  if (!allowed(start)) return { productId: null, finalUrl: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
  try {
    let current = start;
    for (let hop = 0; hop < maxHops; hop += 1) {
      const match = productPattern.exec(current.pathname);
      if (match?.[1]) return { productId: match[1], finalUrl: current };
      const response = await fetcher(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": userAgent },
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      if (response.status === 200 && socialPath.test(current.pathname)) {
        const html = await boundedText(response);
        const productId = html ? featuredProduct(html) : null;
        return productId
          ? { productId, finalUrl: current }
          : { productId: null, finalUrl: current };
      }
      await response.body?.cancel();
      if (response.status < 300 || response.status >= 400 || !location) {
        return { productId: null, finalUrl: current };
      }
      const next = new URL(location, current);
      if (!allowed(next)) return { productId: null, finalUrl: current };
      current = next;
    }
    const match = productPattern.exec(current.pathname);
    return match?.[1]
      ? { productId: match[1], finalUrl: current }
      : { productId: null, finalUrl: current };
  } catch {
    // Timeout (abort) or transport error: the link may be fine, Mercado Livre did not answer.
    return { productId: null, finalUrl: null, failure: "network" };
  } finally {
    clearTimeout(timer);
  }
};
