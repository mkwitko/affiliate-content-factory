import { createHash } from "node:crypto";

export type PublicationFingerprintPayloadV1 = Readonly<{
  schemaVersion: 1;
  variantId: string;
  channelId: string;
  connectionId: string;
  destinationFingerprint: string | null;
  caption: string;
  publishSpec: Readonly<Record<string, unknown>> | null;
  mediaAssetChecksums: readonly string[];
  thumbnailChecksum: string | null;
  language: string;
  voiceScript: readonly string[];
}>;

const canonicalValue = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("publication_fingerprint_invalid_number");
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error("publication_fingerprint_cyclic");
    ancestors.add(value);
    const result = value.map((entry) => {
      if (entry === undefined) throw new Error("publication_fingerprint_unsupported_value");
      return canonicalValue(entry, ancestors);
    });
    ancestors.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("publication_fingerprint_non_plain_object");
    if (ancestors.has(object)) throw new Error("publication_fingerprint_cyclic");
    ancestors.add(object);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const entry = object[key];
      if (entry !== undefined) result[key] = canonicalValue(entry, ancestors);
    }
    ancestors.delete(object);
    return result;
  }
  throw new Error("publication_fingerprint_unsupported_value");
};

export const canonicalPublicationFingerprint = (
  payload: PublicationFingerprintPayloadV1,
): string => {
  const publishSpec = payload.publishSpec
    ? Object.fromEntries(
        Object.entries(payload.publishSpec).filter(([key]) => key !== "thumbnailAssetId"),
      )
    : null;
  return JSON.stringify(canonicalValue({ ...payload, publishSpec }));
};

export const publicationFingerprint = (payload: PublicationFingerprintPayloadV1): string =>
  createHash("sha256").update(canonicalPublicationFingerprint(payload), "utf8").digest("hex");
