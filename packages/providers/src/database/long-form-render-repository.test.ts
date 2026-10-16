import { parseWorkspaceId } from "@money-maker/contracts";
import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "./client.js";
import { PrismaLongFormRenderRepository } from "./long-form-render-repository.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const manifest = buildRenderTimingManifest({
  workspaceId,
  renderId: "render-1",
  storyboardId: "storyboard-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: "script-1",
  scriptChecksum: "b".repeat(64),
  scriptLength: 5,
  renderedAssetId: "video-1",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 2500,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-26T12:00:00.000Z",
  scenes: [
    {
      index: 1,
      fromChar: 0,
      toChar: 5,
      startMs: 0,
      endMs: 2500,
      sourceAssetId: "scene-1",
      sourceAssetChecksum: "d".repeat(64),
    },
  ],
  words: [{ text: "Hello", fromChar: 0, toChar: 5, startMs: 100, endMs: 900, sceneIndex: 1 }],
});

const createRepository = (input: { timingManifest: unknown }) => {
  let row: Record<string, unknown> = {
    id: "render-1",
    workspaceId,
    storyboardId: "storyboard-1",
    attempt: 1,
    status: "PENDING",
    reason: null,
    assetId: null,
    durationMs: null,
    wallTimeMs: null,
    rendererVersion: 1,
    createdAt: new Date("2026-09-26T12:00:00.000Z"),
    updatedAt: new Date("2026-09-26T12:00:00.000Z"),
    timingManifest: input.timingManifest,
  };
  const longFormRender = {
    findFirst: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
      where.workspaceId === workspaceId ? row : null,
    ),
    updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      row = { ...row, ...data, status: "READY" };
      return { count: 1 };
    }),
  };
  return {
    repository: new PrismaLongFormRenderRepository({ longFormRender } as unknown as DatabaseClient),
    longFormRender,
  };
};

describe("PrismaLongFormRenderRepository timing manifest", () => {
  it("lists workspace-scoped recent renders with their source labels and a bounded limit", async () => {
    const row = {
      id: "render-1",
      workspaceId,
      storyboardId: "storyboard-1",
      attempt: 1,
      status: "READY",
      reason: null,
      assetId: "video-1",
      durationMs: 2500,
      wallTimeMs: 1000,
      timingManifest: JSON.parse(JSON.stringify(manifest)),
      rendererVersion: 1,
      createdAt: new Date("2026-09-26T12:00:00.000Z"),
      updatedAt: new Date("2026-09-26T12:00:00.000Z"),
      storyboard: {
        workspaceId,
        contentItemId: "item-1",
        contentItem: { workspaceId, title: "Latest video" },
      },
    };
    const findMany = vi.fn(async () => [row]);
    const repository = new PrismaLongFormRenderRepository({
      longFormRender: { findMany },
    } as unknown as DatabaseClient);

    await expect(
      repository.listRecentForWorkspace({ workspaceId, limit: 99 }),
    ).resolves.toMatchObject([
      {
        render: { id: "render-1", status: "ready", timingManifest: manifest },
        contentItemId: "item-1",
        contentTitle: "Latest video",
      },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        workspaceId,
        storyboard: {
          is: { workspaceId, contentItem: { is: { workspaceId } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
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
  });

  it("does not expose a related content title from another workspace", async () => {
    const otherWorkspaceId = parseWorkspaceId("33333333-3333-4333-8333-333333333333");
    const findMany = vi.fn(async () => [
      {
        id: "render-1",
        workspaceId,
        storyboardId: "storyboard-1",
        attempt: 1,
        status: "READY",
        reason: null,
        assetId: "video-1",
        durationMs: 2500,
        wallTimeMs: 1000,
        timingManifest: JSON.parse(JSON.stringify(manifest)),
        rendererVersion: 1,
        createdAt: new Date("2026-09-26T12:00:00.000Z"),
        updatedAt: new Date("2026-09-26T12:00:00.000Z"),
        storyboard: {
          workspaceId,
          contentItemId: "foreign-item",
          contentItem: { workspaceId: otherWorkspaceId, title: "Private title" },
        },
      },
    ]);
    const repository = new PrismaLongFormRenderRepository({
      longFormRender: { findMany },
    } as unknown as DatabaseClient);

    await expect(repository.listRecentForWorkspace({ workspaceId, limit: 5 })).resolves.toEqual([]);
  });

  it("round-trips a ready manifest and scopes the read by workspace", async () => {
    const { repository, longFormRender } = createRepository({
      timingManifest: JSON.parse(JSON.stringify(manifest)),
    });
    await repository.recordReady({
      workspaceId,
      renderId: "render-1",
      assetId: "video-1",
      assetChecksum: "c".repeat(64),
      durationMs: 2500,
      wallTimeMs: 1000,
      timingManifest: manifest,
    });

    const result = await repository.findForWorkspace({ workspaceId, renderId: "render-1" });
    expect(result?.timingManifest).toEqual(manifest);
    expect(longFormRender.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId, id: "render-1", status: "PENDING" },
        data: expect.objectContaining({ timingManifest: manifest }),
      }),
    );
    expect(longFormRender.findFirst).toHaveBeenCalledWith({
      where: { workspaceId, id: "render-1" },
    });
  });

  it("stores the quality report with the ready render and reads it back", async () => {
    const { repository, longFormRender } = createRepository({
      timingManifest: JSON.parse(JSON.stringify(manifest)),
    });
    const qualityReport = {
      version: 1 as const,
      verdict: "warn" as const,
      checks: [{ id: "loudness" as const, verdict: "warn" as const, detail: "-18 LUFS" }],
      measuredAt: "2026-10-01T00:00:00.000Z",
    };
    await repository.recordReady({
      workspaceId,
      renderId: "render-1",
      assetId: "video-1",
      assetChecksum: "c".repeat(64),
      durationMs: 2500,
      wallTimeMs: 1000,
      timingManifest: manifest,
      qualityReport,
    });
    expect(longFormRender.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qualityReport }) }),
    );
    const result = await repository.findForWorkspace({ workspaceId, renderId: "render-1" });
    expect(result?.qualityReport).toEqual(qualityReport);
  });

  it("keeps legacy null manifests absent", async () => {
    const { repository } = createRepository({ timingManifest: null });
    const result = await repository.findForWorkspace({ workspaceId, renderId: "render-1" });

    expect(result).not.toHaveProperty("timingManifest");
  });

  it("rejects a manifest with a corrupt checksum read from storage", async () => {
    const { repository } = createRepository({
      timingManifest: { ...manifest, durationMs: 2000 },
    });

    await expect(
      repository.findForWorkspace({ workspaceId, renderId: "render-1" }),
    ).rejects.toThrow("long_form_timing_manifest_invalid");
  });

  it("does not return a render from another workspace", async () => {
    const { repository } = createRepository({ timingManifest: null });

    const result = await repository.findForWorkspace({
      workspaceId: parseWorkspaceId("33333333-3333-4333-8333-333333333333"),
      renderId: "render-1",
    });

    expect(result).toBeNull();
  });
});

describe("PrismaLongFormRenderRepository visual review", () => {
  const report = {
    version: 1,
    verdict: "pass",
    checks: [],
    measuredAt: "2026-09-30T00:00:00.000Z",
    visual: { findings: [{ id: "caption_contrast", severity: "BLOCK" }], colorStrip: [] },
  };
  const readyRow = (qualityReport: unknown) => ({
    id: "render-1",
    workspaceId,
    storyboardId: "storyboard-1",
    attempt: 1,
    status: "READY",
    reason: null,
    assetId: "video-1",
    durationMs: 2500,
    wallTimeMs: 1000,
    rendererVersion: 1,
    createdAt: new Date("2026-09-26T12:00:00.000Z"),
    updatedAt: new Date("2026-09-26T12:00:00.000Z"),
    timingManifest: JSON.parse(JSON.stringify(manifest)),
    qualityReport,
  });
  const visual = {
    findings: [
      { id: "caption_contrast", severity: "BLOCK" as const },
      { id: "vlm_clutter", severity: "WARN" as const },
    ],
    colorStrip: [],
    vlm: { vlm: "reviewed" as const, frames: 2 },
  };

  it("replaces only the visual section of a ready render's report, scoped to the workspace", async () => {
    let row = readyRow(report);
    const updateMany = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      row = { ...row, ...data } as typeof row;
      return { count: 1 };
    });
    const repository = new PrismaLongFormRenderRepository({
      longFormRender: { findFirst: vi.fn(async () => row), updateMany },
    } as unknown as DatabaseClient);
    const saved = await repository.recordVisualReview({
      workspaceId,
      renderId: "render-1",
      visual,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId, id: "render-1", status: "READY" } }),
    );
    expect(saved?.qualityReport).toMatchObject({ verdict: "pass", visual });
  });

  it("returns null for a render that is not ready or has no report", async () => {
    for (const row of [{ ...readyRow(report), status: "PENDING" }, readyRow(null)]) {
      const updateMany = vi.fn();
      const repository = new PrismaLongFormRenderRepository({
        longFormRender: { findFirst: vi.fn(async () => row), updateMany },
      } as unknown as DatabaseClient);
      expect(
        await repository.recordVisualReview({ workspaceId, renderId: "render-1", visual }),
      ).toBeNull();
      expect(updateMany).not.toHaveBeenCalled();
    }
  });
});
