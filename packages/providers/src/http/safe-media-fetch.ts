import { isIP } from "node:net";
export type VerifiedMedia = Readonly<{ bytes: Uint8Array; mimeType: string }>;
export type MediaLimits = Readonly<{ maxBytes: number; allowedMimeTypes: readonly string[] }>;
export const privateHost = (host: string) => {
  const normalized = host.replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "metadata.google.internal") return true;
  const version = isIP(normalized);
  if (version === 4) {
    const [a = 0, b = 0] = normalized.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  return (
    version === 6 &&
    (normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd"))
  );
};
export const fetchSafeMedia = async (
  url: URL,
  limits: MediaLimits,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedMedia> => {
  if (url.protocol !== "https:" || privateHost(url.hostname)) throw new Error("url_not_public");
  const response = await fetcher(url, { redirect: "error" });
  if (!response.ok) throw new Error("media_fetch_failed");
  const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0];
  if (!mimeType || !limits.allowedMimeTypes.includes(mimeType)) throw new Error("mime_not_allowed");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > limits.maxBytes) throw new Error("media_too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limits.maxBytes) throw new Error("media_too_large");
  if (bytes.byteLength < 8) throw new Error("media_truncated");
  return { bytes, mimeType };
};
