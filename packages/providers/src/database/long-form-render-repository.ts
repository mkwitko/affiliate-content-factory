import { parseWorkspaceId } from "@money-maker/contracts";
import type {
  LongFormRender,
  LongFormRenderRepository,
} from "@money-maker/core/publishing/long-form-render";
import {
  parseRenderQualityReport,
  type RenderQualityReport,
} from "@money-maker/core/publishing/render-quality";
import { parseRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const toDomain = (row: {
  id: string;
  workspaceId: string;
  storyboardId: string;
  attempt: number;
  status: string;
  reason: string | null;
  assetId: string | null;
  durationMs: number | null;
  wallTimeMs: number | null;
  timingManifest: unknown;
  qualityReport?: unknown;
  rendererVersion: number;
  createdAt: Date;
  updatedAt: Date;
}): LongFormRender => {
  const timingManifest = parseRenderTimingManifest(row.timingManifest);
  const qualityReport = parseRenderQualityReport(row.qualityReport);
  return {
    id: row.id,
    workspaceId: parseWorkspaceId(row.workspaceId),
    storyboardId: row.storyboardId,
    attempt: row.attempt,
    status: row.status.toLowerCase() as LongFormRender["status"],
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.assetId ? { assetId: row.assetId } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.wallTimeMs !== null ? { wallTimeMs: row.wallTimeMs } : {}),
    ...(timingManifest ? { timingManifest } : {}),
    ...(qualityReport ? { qualityReport } : {}),
    rendererVersion: row.rendererVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
};
export class PrismaLongFormRenderRepository implements LongFormRenderRepository {
  public constructor(private readonly client: DatabaseClient) {}
  public async createPending(input: {
    id: string;
    workspaceId: LongFormRender["workspaceId"];
    storyboardId: string;
    rendererVersion: number;
  }) {
    const latest = await this.client.longFormRender.findFirst({
      where: { workspaceId: input.workspaceId, storyboardId: input.storyboardId },
      orderBy: { attempt: "desc" },
    });
    if (latest && latest.status !== "FAILED") return { created: false, render: toDomain(latest) };
    const attempt = (latest?.attempt ?? 0) + 1;
    try {
      const row = await this.client.longFormRender.create({
        data: {
          id: input.id,
          workspaceId: input.workspaceId,
          storyboardId: input.storyboardId,
          attempt,
          rendererVersion: input.rendererVersion,
          status: "PENDING",
        },
      });
      return { created: true, render: toDomain(row) };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "P2002"
      ) {
        const current = await this.client.longFormRender.findFirst({
          where: { workspaceId: input.workspaceId, storyboardId: input.storyboardId },
          orderBy: { attempt: "desc" },
        });
        if (current) return { created: false, render: toDomain(current) };
      }
      throw error;
    }
  }
  public async findForWorkspace(input: {
    workspaceId: LongFormRender["workspaceId"];
    renderId: string;
  }) {
    const row = await this.client.longFormRender.findFirst({
      where: { workspaceId: input.workspaceId, id: input.renderId },
    });
    return row ? toDomain(row) : null;
  }
  public async listRecentForWorkspace(input: {
    workspaceId: LongFormRender["workspaceId"];
    limit: number;
  }) {
    const rows = await this.client.longFormRender.findMany({
      where: {
        workspaceId: input.workspaceId,
        storyboard: {
          is: {
            workspaceId: input.workspaceId,
            contentItem: { is: { workspaceId: input.workspaceId } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: Math.max(1, Math.min(Math.floor(input.limit), 10)),
      include: {
        storyboard: {
          select: {
            workspaceId: true,
            contentItemId: true,
            contentItem: { select: { workspaceId: true, title: true } },
          },
        },
      },
    });
    return rows.flatMap((row) => {
      if (
        row.storyboard.workspaceId !== input.workspaceId ||
        row.storyboard.contentItem.workspaceId !== input.workspaceId
      )
        return [];
      return [
        {
          render: toDomain(row),
          contentItemId: row.storyboard.contentItemId,
          contentTitle: row.storyboard.contentItem.title,
        },
      ];
    });
  }
  public async recordReady(input: {
    workspaceId: LongFormRender["workspaceId"];
    renderId: string;
    assetId: string;
    assetChecksum: string;
    durationMs: number;
    wallTimeMs: number;
    timingManifest: NonNullable<LongFormRender["timingManifest"]>;
    qualityReport?: RenderQualityReport | undefined;
  }) {
    const timingManifest = parseRenderTimingManifest(input.timingManifest);
    if (!timingManifest) throw new Error("long_form_timing_manifest_invalid");
    const current = await this.findForWorkspace(input);
    if (
      !current ||
      timingManifest.workspaceId !== input.workspaceId ||
      timingManifest.renderId !== input.renderId ||
      timingManifest.storyboardId !== current.storyboardId ||
      timingManifest.renderedAssetId !== input.assetId ||
      timingManifest.renderedAssetChecksum !== input.assetChecksum ||
      timingManifest.durationMs !== input.durationMs ||
      timingManifest.rendererVersion !== current.rendererVersion
    )
      throw new Error("long_form_timing_manifest_binding_mismatch");
    if (current.status === "ready") {
      if (current.timingManifest?.manifestChecksum === timingManifest.manifestChecksum)
        return current;
      throw new Error("long_form_render_not_pending");
    }
    if (current.status !== "pending") throw new Error("long_form_render_not_pending");
    const changed = await this.client.longFormRender.updateMany({
      where: { workspaceId: input.workspaceId, id: input.renderId, status: "PENDING" },
      data: {
        status: "READY",
        assetId: input.assetId,
        durationMs: input.durationMs,
        wallTimeMs: input.wallTimeMs,
        timingManifest,
        qualityReport: input.qualityReport ?? Prisma.DbNull,
        reason: null,
      },
    });
    const row = await this.findForWorkspace(input);
    if (
      !row ||
      (!changed.count && row.timingManifest?.manifestChecksum !== timingManifest.manifestChecksum)
    )
      throw new Error("long_form_render_not_pending");
    return row;
  }
  public async recordFailed(input: {
    workspaceId: LongFormRender["workspaceId"];
    renderId: string;
    reason: string;
    qualityReport?: RenderQualityReport | undefined;
  }) {
    const changed = await this.client.longFormRender.updateMany({
      where: { workspaceId: input.workspaceId, id: input.renderId, status: "PENDING" },
      data: {
        status: "FAILED",
        reason: input.reason.slice(0, 500),
        ...(input.qualityReport ? { qualityReport: input.qualityReport } : {}),
      },
    });
    const row = await this.findForWorkspace(input);
    if (!row || (!changed.count && row.status !== "failed"))
      throw new Error("long_form_render_not_pending");
    return row;
  }
  public async recordVisualReview(input: {
    workspaceId: LongFormRender["workspaceId"];
    renderId: string;
    visual: NonNullable<RenderQualityReport["visual"]>;
  }) {
    const current = await this.findForWorkspace(input);
    if (current?.status !== "ready" || !current.qualityReport) return null;
    const changed = await this.client.longFormRender.updateMany({
      where: { workspaceId: input.workspaceId, id: input.renderId, status: "READY" },
      data: { qualityReport: { ...current.qualityReport, visual: input.visual } },
    });
    return changed.count ? this.findForWorkspace(input) : null;
  }
}
