const defaultApiOrigin = "https://mcp.example.com";

export type WebWorkerEnv = Readonly<{
  ASSETS?: Readonly<{ fetch: (request: Request) => Promise<Response> }>;
  ASSET_CONTENT?: Readonly<Record<string, InlineAsset>>;
  API_ORIGIN?: string;
}>;

export type InlineAsset = Readonly<{
  body: string;
  contentType: string;
}>;

type UpstreamFetch = (request: Request) => Promise<Response>;

// /go/* are tracked links; serving them here keeps posted URLs on the public domain.
const isApiRoute = (pathname: string): boolean =>
  pathname === "/health" ||
  pathname === "/v1" ||
  pathname.startsWith("/v1/") ||
  pathname.startsWith("/go/");

const apiRequest = (request: Request, apiOrigin: string): Request => {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(apiOrigin);
  targetUrl.pathname = sourceUrl.pathname;
  targetUrl.search = sourceUrl.search;
  return new Request(targetUrl, request);
};

const staticAsset = async (request: Request, environment: WebWorkerEnv): Promise<Response> => {
  if (environment.ASSETS) return environment.ASSETS.fetch(request);
  const url = new URL(request.url);
  const asset =
    environment.ASSET_CONTENT?.[url.pathname] ?? environment.ASSET_CONTENT?.["/index.html"];
  if (!asset) return new Response("Not Found", { status: 404 });
  // Only content-hashed build assets are immutable; the HTML shell must revalidate.
  const hashed = url.pathname.startsWith("/assets/") && environment.ASSET_CONTENT?.[url.pathname];
  return new Response(asset.body, {
    headers: {
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "content-type": asset.contentType,
    },
  });
};

export const handleRequest = async (
  request: Request,
  environment: WebWorkerEnv,
  upstreamFetch: UpstreamFetch = fetch,
): Promise<Response> => {
  const url = new URL(request.url);
  if (!isApiRoute(url.pathname)) return staticAsset(request, environment);

  const upstreamRequest = apiRequest(request, environment.API_ORIGIN ?? defaultApiOrigin);
  return upstreamFetch(upstreamRequest);
};

export default { fetch: handleRequest };
