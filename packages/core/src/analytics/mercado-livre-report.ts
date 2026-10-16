import { createHash } from "node:crypto";

export type MercadoLivreReportInspection = Readonly<{
  status: "awaiting_real_sample";
  sha256: string;
  originalBytes: Uint8Array;
  discoveredHeaders: readonly string[];
  unknownHeaders: readonly string[];
  mappingVersion: null;
  normalizedRows: readonly [];
}>;

export type MercadoLivreReportInspectionResult =
  | MercadoLivreReportInspection
  | Readonly<{
      status: "rejected";
      error: "ambiguous_headers";
      sha256: string;
      originalBytes: Uint8Array;
      discoveredHeaders: readonly string[];
    }>;

/** Header mapping remains disabled until an actual redacted provider export establishes it. */
export const inspectMercadoLivreReport = (input: {
  originalBytes: Uint8Array;
  discoveredHeaders: readonly string[];
}): MercadoLivreReportInspectionResult => {
  const originalBytes = Uint8Array.from(input.originalBytes);
  const sha256 = createHash("sha256").update(originalBytes).digest("hex");
  const normalizedHeaders = input.discoveredHeaders.map((header) => header.trim().toLowerCase());
  if (
    normalizedHeaders.some((header) => header.length === 0) ||
    new Set(normalizedHeaders).size !== normalizedHeaders.length
  )
    return {
      status: "rejected",
      error: "ambiguous_headers",
      sha256,
      originalBytes,
      discoveredHeaders: [...input.discoveredHeaders],
    };
  return {
    status: "awaiting_real_sample",
    sha256,
    originalBytes,
    discoveredHeaders: [...input.discoveredHeaders],
    unknownHeaders: [...input.discoveredHeaders],
    mappingVersion: null,
    normalizedRows: [],
  };
};
