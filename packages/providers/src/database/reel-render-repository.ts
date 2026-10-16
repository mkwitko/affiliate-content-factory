import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import type {
  ReelRender,
  ReelRenderRepository,
  ReelRenderStatus,
  ReelVoiceMode,
} from "@money-maker/core/publishing/reel-render";
import type { NarrationCheck } from "@money-maker/core/publishing/narration-check";
import {
  parseRenderQualityReport,
  type RenderQualityReport,
  withNarrationCheck,
} from "@money-maker/core/publishing/render-quality";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type ReelRenderRecord = {
  id: string;
  workspaceId: string;
  sourceVariantId: string;
  status: "PENDING" | "READY" | "FAILED";
  assetId: string | null;
  reason: string | null;
  musicTrackId: string | null;
  voiceMode: "SCRIPT" | "NONE";
  voiceId: string | null;
  durationMs: number | null;
  qualityReport?: unknown;
  attempt: number;
  createdAt: Date;
  updatedAt: Date;
};

const toDomain = (record: ReelRenderRecord): ReelRender => {
  const qualityReport = parseRenderQualityReport(record.qualityReport);
  return Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    sourceVariantId: record.sourceVariantId,
    status: record.status.toLowerCase() as ReelRenderStatus,
    ...(record.assetId ? { assetId: record.assetId } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.musicTrackId ? { musicTrackId: record.musicTrackId } : {}),
    voiceMode: record.voiceMode.toLowerCase() as ReelVoiceMode,
    ...(record.voiceId ? { voiceId: record.voiceId } : {}),
    ...(record.durationMs !== null ? { durationMs: record.durationMs } : {}),
    ...(qualityReport ? { qualityReport } : {}),
    attempt: record.attempt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
};

const isUniqueConstraintError = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

export class PrismaReelRenderRepository implements ReelRenderRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createPending(input: {
    id?: string;
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    voiceMode: ReelVoiceMode;
  }): Promise<Readonly<{ created: boolean; render: ReelRender }>> {
    try {
      const record = await this.client.reelRender.create({
        data: {
          id: input.id ?? crypto.randomUUID(),
          workspaceId: input.workspaceId,
          sourceVariantId: input.sourceVariantId,
          voiceMode: input.voiceMode.toUpperCase() as "SCRIPT" | "NONE",
        },
      });
      return { created: true, render: toDomain(record as ReelRenderRecord) };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.findForWorkspace({
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
      });
      if (!existing) throw error;
      return { created: false, render: existing };
    }
  }

  public async resetForRetry(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    voiceMode: ReelVoiceMode;
  }): Promise<ReelRender> {
    await this.client.reelRender.updateMany({
      where: {
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
        // A render that just became READY (e.g. a worker's recordReady landed between this
        // call's caller reading a stale/failed row and this updateMany) must never be reset:
        // this filter makes the update a no-op for it, so the row and its asset are untouched.
        status: { in: ["FAILED", "PENDING"] },
      },
      data: {
        status: "PENDING",
        assetId: null,
        reason: null,
        musicTrackId: null,
        voiceId: null,
        durationMs: null,
        qualityReport: Prisma.DbNull,
        voiceMode: input.voiceMode === "none" ? "NONE" : "SCRIPT",
        attempt: { increment: 1 },
      },
    });
    const updated = await this.findForWorkspace(input);
    if (!updated) throw new Error("reel_render_not_found");
    return updated;
  }

  public async findForWorkspace(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
  }): Promise<ReelRender | null> {
    const record = await this.client.reelRender.findFirst({
      where: { workspaceId: input.workspaceId, sourceVariantId: input.sourceVariantId },
    });
    return record ? toDomain(record as ReelRenderRecord) : null;
  }

  public async findByAssetForWorkspace(input: {
    workspaceId: WorkspaceId;
    assetId: string;
  }): Promise<ReelRender | null> {
    const record = await this.client.reelRender.findFirst({
      where: { workspaceId: input.workspaceId, assetId: input.assetId },
    });
    return record ? toDomain(record as ReelRenderRecord) : null;
  }

  public async recordReady(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    assetId: string;
    musicTrackId?: string;
    voiceId?: string;
    durationMs: number;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<ReelRender> {
    await this.client.reelRender.updateMany({
      // First resolution wins: a late attempt (lease expired mid-render) never replaces it.
      where: {
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
        status: "PENDING",
      },
      data: {
        status: "READY",
        assetId: input.assetId,
        reason: null,
        musicTrackId: input.musicTrackId ?? null,
        voiceId: input.voiceId ?? null,
        durationMs: input.durationMs,
        qualityReport: input.qualityReport ?? Prisma.DbNull,
      },
    });
    const updated = await this.findForWorkspace(input);
    if (!updated) throw new Error("reel_render_not_found");
    return updated;
  }

  public async recentMusicTrackIds(input: {
    workspaceId: WorkspaceId;
    limit: number;
  }): Promise<readonly string[]> {
    const records = await this.client.reelRender.findMany({
      where: { workspaceId: input.workspaceId, status: "READY", musicTrackId: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: input.limit,
      select: { musicTrackId: true },
    });
    return records.flatMap((record) => (record.musicTrackId ? [record.musicTrackId] : []));
  }

  public async recordFailed(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    reason: string;
    qualityReport?: RenderQualityReport | undefined;
  }): Promise<ReelRender> {
    await this.client.reelRender.updateMany({
      // First resolution wins: a late attempt (lease expired mid-render) never replaces it.
      where: {
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
        status: "PENDING",
      },
      data: {
        status: "FAILED",
        reason: input.reason,
        qualityReport: input.qualityReport ?? Prisma.DbNull,
      },
    });
    const updated = await this.findForWorkspace(input);
    if (!updated) throw new Error("reel_render_not_found");
    return updated;
  }

  public async recordNarrationCheck(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    assetId: string;
    narration: NarrationCheck;
  }): Promise<ReelRender | null> {
    const current = await this.findForWorkspace(input);
    if (current?.status !== "ready" || current.assetId !== input.assetId || !current.qualityReport)
      return null;
    // The asset id in the filter keeps a re-render that swapped the video from taking this result.
    const changed = await this.client.reelRender.updateMany({
      where: {
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
        status: "READY",
        assetId: input.assetId,
      },
      data: { qualityReport: withNarrationCheck(current.qualityReport, input.narration) },
    });
    return changed.count ? this.findForWorkspace(input) : null;
  }

  public async invalidateReady(input: {
    workspaceId: WorkspaceId;
    sourceVariantId: string;
    reason: string;
  }): Promise<void> {
    await this.client.reelRender.updateMany({
      where: {
        workspaceId: input.workspaceId,
        sourceVariantId: input.sourceVariantId,
        status: "READY",
      },
      data: { status: "FAILED", reason: input.reason, assetId: null },
    });
  }
}
