import { describe, expect, it } from "vitest";
import {
  canonicalPublicationFingerprint,
  type PublicationFingerprintPayloadV1,
  publicationFingerprint,
} from "./publication-fingerprint.js";

const vectorA: PublicationFingerprintPayloadV1 = {
  schemaVersion: 1,
  variantId: "5c1c4a2e-3d6b-4f4e-9b7a-0e1f2a3b4c5d",
  channelId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  connectionId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  destinationFingerprint: null,
  caption: "Três ideias para organizar a mesa",
  publishSpec: null,
  mediaAssetChecksums: ["a".repeat(64)],
  thumbnailChecksum: null,
  language: "pt-BR",
  voiceScript: [],
};

describe("publication fingerprint v1", () => {
  it("matches golden vector A byte for byte", () => {
    expect(canonicalPublicationFingerprint(vectorA)).toBe(
      '{"caption":"Três ideias para organizar a mesa","channelId":"7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d","connectionId":"0f1e2d3c-4b5a-4968-8776-655443322110","destinationFingerprint":null,"language":"pt-BR","mediaAssetChecksums":["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"publishSpec":null,"schemaVersion":1,"thumbnailChecksum":null,"variantId":"5c1c4a2e-3d6b-4f4e-9b7a-0e1f2a3b4c5d","voiceScript":[]}',
    );
    expect(publicationFingerprint(vectorA)).toBe(
      "4f7bb00e36c727337b89c787ada3809c041999c9ce076b29e914b167206bf2d3",
    );
  });

  it("matches commerce vector B and YouTube vector C", () => {
    const vectorB = {
      ...vectorA,
      destinationFingerprint: "9305a6fb968b5847ae52c85f65b2f8be8f9d2d059cfa08bcc336a4064d9420bc",
      caption: "#publi Toque no link\nhttps://meli.la/abc",
      mediaAssetChecksums: ["1".repeat(64), "2".repeat(64), "3".repeat(64)],
      voiceScript: ["Olha isso", "Custa pouco", "Link na descrição"],
    };
    expect(publicationFingerprint(vectorB)).toBe(
      "fa55af1cb3f3ea2b3aaa875064a936557f2ff79db92fde422eb17db7dc352714",
    );
    const vectorC = {
      ...vectorA,
      caption: "Descrição do vídeo",
      mediaAssetChecksums: ["b".repeat(64)],
      thumbnailChecksum: "c".repeat(64),
      publishSpec: {
        schemaVersion: 1,
        title: "Por que o Brasil trocou de capital",
        intendedFormat: "long_form",
        privacyStatus: "private",
        madeForKids: false,
        containsSyntheticMedia: false,
        defaultLanguage: "pt-BR",
      },
    } as const;
    expect(publicationFingerprint(vectorC)).toBe(
      "84d858866c426b9d55b4991253cd1787e99e4700ac5755b3d3e477f98823b955",
    );
  });

  it("sorts nested keys, preserves arrays, omits undefined, and preserves null", () => {
    const payload = { ...vectorA, publishSpec: { z: null, a: undefined, nested: { b: 2, a: 1 } } };
    expect(canonicalPublicationFingerprint(payload)).toContain(
      '"publishSpec":{"nested":{"a":1,"b":2},"z":null}',
    );
    expect(() =>
      canonicalPublicationFingerprint({ ...vectorA, publishSpec: { bad: Infinity } }),
    ).toThrow("publication_fingerprint_invalid_number");
  });

  it("is sensitive to exact caption whitespace and media array order", () => {
    expect(publicationFingerprint({ ...vectorA, caption: `${vectorA.caption} ` })).not.toBe(
      publicationFingerprint(vectorA),
    );
    expect(
      publicationFingerprint({ ...vectorA, mediaAssetChecksums: ["b".repeat(64), "a".repeat(64)] }),
    ).not.toBe(
      publicationFingerprint({ ...vectorA, mediaAssetChecksums: ["a".repeat(64), "b".repeat(64)] }),
    );
  });

  it("binds a thumbnail by checksum, never by its physical asset id", () => {
    const withThumbnail = {
      ...vectorA,
      thumbnailChecksum: "c".repeat(64),
      publishSpec: { schemaVersion: 1, title: "Video", thumbnailAssetId: "asset-a" },
    } as PublicationFingerprintPayloadV1;
    expect(
      publicationFingerprint({
        ...withThumbnail,
        publishSpec: { ...withThumbnail.publishSpec!, thumbnailAssetId: "asset-b" },
      } as PublicationFingerprintPayloadV1),
    ).toBe(publicationFingerprint(withThumbnail));
    expect(
      publicationFingerprint({ ...withThumbnail, thumbnailChecksum: "d".repeat(64) }),
    ).not.toBe(publicationFingerprint(withThumbnail));
  });
});
