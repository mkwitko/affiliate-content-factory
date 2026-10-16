import { parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetRepository } from "@money-maker/core/assets/asset-repository";
import type { DatabaseClient } from "./client.js";
import { STAGE_ARTIFACT_ROLE } from "@money-maker/core/assets/stage-cache";
import { Prisma } from "../../generated/prisma/client.js";

const toJsonValue = (value: unknown): Prisma.InputJsonValue | null => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("asset_metadata_invalid");
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, nested]) =>
        nested === undefined ? [] : [[key, toJsonValue(nested)]],
      ),
    );
  }
  throw new Error("asset_metadata_invalid");
};

const toDomain = (record: {
  id: string;
  workspaceId: string;
  objectKey: string;
  checksum: string;
  mimeType: string;
  width: number;
  height: number;
  durationMs: number | null;
  byteSize: number | null;
  provenance: string;
  license: string;
  commercialUse: boolean | null;
  sourceUrl: string | null;
  creator: string | null;
  metadata: unknown;
  state: "PENDING" | "ACTIVE" | "ARCHIVED" | "PENDING_REVIEW";
}): Asset =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    objectKey: record.objectKey,
    checksum: record.checksum,
    mimeType: record.mimeType,
    width: record.width,
    height: record.height,
    ...(record.durationMs !== null ? { durationMs: record.durationMs } : {}),
    ...(record.byteSize !== null ? { byteSize: record.byteSize } : {}),
    provenance: record.provenance as Asset["provenance"],
    license: record.license,
    commercialUse: record.commercialUse,
    ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
    ...(record.creator ? { creator: record.creator } : {}),
    ...(record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? { metadata: record.metadata as Readonly<Record<string, unknown>> }
      : {}),
    state: record.state.toLowerCase() as Asset["state"],
  });

const dbState = (state: Asset["state"]) =>
  state.toUpperCase() as "PENDING" | "ACTIVE" | "ARCHIVED" | "PENDING_REVIEW";

export class PrismaAssetRepository implements AssetRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listForWorkspace(
    workspaceId: Asset["workspaceId"],
    state: Asset["state"] = "active",
  ): Promise<readonly Asset[]> {
    const records = await this.client.asset.findMany({
      where: {
        workspaceId,
        state: dbState(state),
        // Cache entries are infrastructure (spec INV-C4). A bare NOT on a JSON path filter would
        // also drop rows whose metadata is NULL or has no role (SQL NULL), so both are spelled out.
        OR: [
          { metadata: { equals: Prisma.DbNull } },
          { metadata: { path: ["role"], equals: Prisma.AnyNull } },
          { NOT: { metadata: { path: ["role"], equals: STAGE_ARTIFACT_ROLE } } },
        ],
      },
      orderBy: { updatedAt: "desc" },
    });
    return records.map(toDomain);
  }

  public async create(asset: Asset): Promise<Asset> {
    const record = await this.client.asset.create({
      data: {
        id: asset.id,
        workspaceId: asset.workspaceId,
        objectKey: asset.objectKey,
        checksum: asset.checksum,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        durationMs: asset.durationMs ?? null,
        byteSize: asset.byteSize ?? null,
        provenance: asset.provenance,
        license: asset.license,
        commercialUse: asset.commercialUse,
        sourceUrl: asset.sourceUrl ?? null,
        creator: asset.creator ?? null,
        ...(asset.metadata
          ? { metadata: toJsonValue(asset.metadata) as Prisma.InputJsonObject }
          : {}),
        state: dbState(asset.state),
      },
    });
    return toDomain(record);
  }

  public async findForWorkspace(input: {
    workspaceId: Asset["workspaceId"];
    assetId: string;
  }): Promise<Asset | null> {
    const record = await this.client.asset.findFirst({
      where: { id: input.assetId, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record) : null;
  }

  public async findByMetadata(input: {
    workspaceId: Asset["workspaceId"];
    role: string;
    key: string;
    value: string;
  }): Promise<Asset | null> {
    const record = await this.client.asset.findFirst({
      where: {
        workspaceId: input.workspaceId,
        state: "ACTIVE",
        AND: [
          { metadata: { path: ["role"], equals: input.role } },
          { metadata: { path: [input.key], equals: input.value } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    return record ? toDomain(record) : null;
  }

  public async listByMetadata(input: {
    workspaceId: Asset["workspaceId"];
    role: string;
    key: string;
    value: string;
    state?: Asset["state"];
  }): Promise<readonly Asset[]> {
    const records = await this.client.asset.findMany({
      where: {
        workspaceId: input.workspaceId,
        state: dbState(input.state ?? "active"),
        AND: [
          { metadata: { path: ["role"], equals: input.role } },
          { metadata: { path: [input.key], equals: input.value } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    return records.map(toDomain);
  }

  public async updateMetadata(input: {
    workspaceId: Asset["workspaceId"];
    assetId: string;
    patch: Readonly<Record<string, unknown>>;
  }): Promise<Asset | null> {
    const current = await this.client.asset.findFirst({
      where: { id: input.assetId, workspaceId: input.workspaceId },
    });
    if (!current) return null;
    const metadata = {
      ...(current.metadata &&
      typeof current.metadata === "object" &&
      !Array.isArray(current.metadata)
        ? (current.metadata as Record<string, unknown>)
        : {}),
      ...input.patch,
    };
    await this.client.asset.updateMany({
      where: { id: input.assetId, workspaceId: input.workspaceId },
      data: { metadata: toJsonValue(metadata) as Prisma.InputJsonObject },
    });
    return this.findForWorkspace({ workspaceId: input.workspaceId, assetId: input.assetId });
  }

  public async updateState(input: {
    workspaceId: Asset["workspaceId"];
    assetId: string;
    state: Asset["state"];
  }): Promise<Asset | null> {
    const updated = await this.client.asset.updateMany({
      where: { id: input.assetId, workspaceId: input.workspaceId },
      data: { state: dbState(input.state) },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, assetId: input.assetId });
  }

  public async completeRenderedAsset(input: {
    workspaceId: Asset["workspaceId"];
    assetId: string;
    checksum: string;
    byteSize: number;
    durationMs: number;
    width: number;
    height: number;
    metadata: Readonly<Record<string, unknown>>;
  }): Promise<Asset | null> {
    const updated = await this.client.asset.updateMany({
      where: {
        id: input.assetId,
        workspaceId: input.workspaceId,
        state: "PENDING",
        provenance: "RENDERED",
      },
      data: {
        checksum: input.checksum,
        byteSize: input.byteSize,
        durationMs: input.durationMs,
        width: input.width,
        height: input.height,
        metadata: toJsonValue(input.metadata) as Prisma.InputJsonObject,
        state: "ACTIVE",
      },
    });
    return updated.count
      ? this.findForWorkspace({ workspaceId: input.workspaceId, assetId: input.assetId })
      : null;
  }

  public async updateRights(input: {
    workspaceId: Asset["workspaceId"];
    assetId: string;
    commercialUse: boolean | null;
    license: string;
    sourceUrl?: string | null;
    creator?: string | null;
  }): Promise<Asset | null> {
    const updated = await this.client.asset.updateMany({
      where: { id: input.assetId, workspaceId: input.workspaceId },
      data: {
        commercialUse: input.commercialUse,
        license: input.license,
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.creator !== undefined ? { creator: input.creator } : {}),
      },
    });
    return updated.count
      ? this.findForWorkspace({ workspaceId: input.workspaceId, assetId: input.assetId })
      : null;
  }
}
