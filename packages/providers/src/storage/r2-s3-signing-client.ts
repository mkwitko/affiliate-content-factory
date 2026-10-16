import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { VerifiedAssetUpload } from "@money-maker/core/assets/asset-store";
import { createHash } from "node:crypto";
import type { R2SigningClient } from "./r2-asset-store.js";

export type R2S3SigningClientConfiguration = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}>;

const metadataValue = (metadata: Readonly<Record<string, string>>, key: string): string => {
  const value = metadata[key.toLowerCase()];
  if (!value || value.trim().length === 0) throw new Error("Stored asset metadata is incomplete");
  return value;
};

const parseDimension = (metadata: Readonly<Record<string, string>>, key: string): number => {
  const value = Number.parseInt(metadataValue(metadata, key), 10);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error("Stored asset dimensions are invalid");
  return value;
};

type ImageInspection = Readonly<{ mimeType: string; width: number; height: number }>;

const byteAt = (bytes: Uint8Array, index: number): number => {
  const value = bytes[index];
  if (value === undefined) throw new Error("Stored image bytes are truncated");
  return value;
};

const ascii = (bytes: Uint8Array, start: number, value: string): boolean =>
  value
    .split("")
    .every((character, index) => byteAt(bytes, start + index) === character.charCodeAt(0));

const readUint24LittleEndian = (bytes: Uint8Array, offset: number): number =>
  byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16);

const inspectImage = (bytes: Uint8Array): ImageInspection => {
  if (
    bytes.length >= 24 &&
    byteAt(bytes, 0) === 0x89 &&
    byteAt(bytes, 1) === 0x50 &&
    byteAt(bytes, 2) === 0x4e &&
    byteAt(bytes, 3) === 0x47 &&
    byteAt(bytes, 4) === 0x0d &&
    byteAt(bytes, 5) === 0x0a &&
    byteAt(bytes, 6) === 0x1a &&
    byteAt(bytes, 7) === 0x0a
  ) {
    return {
      mimeType: "image/png",
      width: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16),
      height: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20),
    };
  }

  if (bytes.length >= 12 && ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) {
    if (bytes.length >= 30 && ascii(bytes, 12, "VP8X")) {
      return {
        mimeType: "image/webp",
        width: 1 + readUint24LittleEndian(bytes, 24),
        height: 1 + readUint24LittleEndian(bytes, 27),
      };
    }
    throw new Error("Stored WebP format is not supported for verification");
  }

  if (bytes.length >= 4 && byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (byteAt(bytes, offset) !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = byteAt(bytes, offset + 1);
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && segmentLength >= 7) {
        return {
          mimeType: "image/jpeg",
          height: (byteAt(bytes, offset + 3) << 8) | byteAt(bytes, offset + 4),
          width: (byteAt(bytes, offset + 5) << 8) | byteAt(bytes, offset + 6),
        };
      }
      offset += segmentLength;
    }
  }

  throw new Error("Stored object is not a supported image");
};

const readObjectBytes = async (body: unknown): Promise<Uint8Array> => {
  if (
    !body ||
    typeof body !== "object" ||
    !("transformToByteArray" in body) ||
    typeof body.transformToByteArray !== "function"
  ) {
    throw new Error("Stored asset body is unavailable");
  }
  return body.transformToByteArray();
};

const verifiedUpload = async (input: {
  body: unknown;
  contentType?: string;
  contentLength?: number;
  metadata?: Readonly<Record<string, string>>;
}): Promise<VerifiedAssetUpload> => {
  if (!input.contentType || input.contentType.trim().length === 0) {
    throw new Error("Stored asset MIME type is missing");
  }
  if (input.contentLength !== undefined && input.contentLength > 25 * 1024 * 1024) {
    throw new Error("Stored asset exceeds the maximum verified size");
  }
  const metadata = input.metadata ?? {};
  const expectedChecksum = metadataValue(metadata, "checksum");
  const bytes = await readObjectBytes(input.body);
  const actualChecksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (actualChecksum !== expectedChecksum) {
    throw new Error("Stored asset checksum does not match");
  }
  const image = inspectImage(bytes);
  if (image.mimeType !== input.contentType) {
    throw new Error("Stored asset MIME type does not match");
  }
  if (image.width !== parseDimension(metadata, "width")) {
    throw new Error("Stored asset width does not match");
  }
  if (image.height !== parseDimension(metadata, "height")) {
    throw new Error("Stored asset height does not match");
  }
  return { checksum: actualChecksum, ...image };
};

export const createR2S3SigningClient = (
  configuration: R2S3SigningClientConfiguration,
  client = new S3Client({
    region: "auto",
    endpoint: `https://${configuration.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  }),
): R2SigningClient => ({
  createUploadUrl: async ({ key, contentType, metadata, expiresInSeconds }) =>
    getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: configuration.bucketName,
        Key: key,
        ContentType: contentType,
        Metadata: metadata,
      }),
      { expiresIn: expiresInSeconds },
    ),
  createDownloadUrl: ({ key, expiresInSeconds }) =>
    getSignedUrl(client, new GetObjectCommand({ Bucket: configuration.bucketName, Key: key }), {
      expiresIn: expiresInSeconds,
    }),
  putObject: async ({ key, contentType, metadata, body }) => {
    await client.send(
      new PutObjectCommand({
        Bucket: configuration.bucketName,
        Key: key,
        ContentType: contentType,
        Metadata: metadata,
        Body: body,
      }),
    );
  },
  deleteObject: async (key) => {
    await client.send(new DeleteObjectCommand({ Bucket: configuration.bucketName, Key: key }));
  },
  verifyObject: async ({ key }) => {
    const object = await client.send(
      new GetObjectCommand({ Bucket: configuration.bucketName, Key: key }),
    );
    return verifiedUpload({
      body: object.Body,
      ...(object.ContentType ? { contentType: object.ContentType } : {}),
      ...(object.ContentLength !== undefined ? { contentLength: object.ContentLength } : {}),
      ...(object.Metadata ? { metadata: object.Metadata } : {}),
    });
  },
});
