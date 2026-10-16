import { parseWorkspaceId } from "@money-maker/contracts";
import { PermanentJobError } from "@money-maker/core/jobs/job";
import type { LongFormRender } from "@money-maker/core/publishing/long-form-render";
import type { RenderQualityReport } from "@money-maker/core/publishing/render-quality";
import { describe, expect, it, vi } from "vitest";
import {
  createReviewFramesHandler,
  createReviewFramesJob,
  keyFramePlan,
  type ReviewFramesDependencies,
} from "./review-frames.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const checksum = "a".repeat(64);
const scene = (index: number, startMs: number, endMs: number) => ({
  index,
  fromChar: 0,
  toChar: 1,
  startMs,
  endMs,
  sourceAssetId: "s",
  sourceAssetChecksum: checksum,
});
const quality = (overrides: Partial<RenderQualityReport> = {}): RenderQualityReport => ({
  version: 1,
  verdict: "pass",
  checks: [],
  measuredAt: "2026-09-30T00:00:00.000Z",
  visual: {
    findings: [{ id: "caption_contrast", severity: "BLOCK", sceneIndex: 1 }],
    colorStrip: [],
  },
  ...overrides,
});
const render = (overrides: Partial<LongFormRender> = {}): LongFormRender =>
  ({
    id: "render-1",
    workspaceId,
    storyboardId: "board-1",
    attempt: 1,
    status: "ready",
    assetId: "asset-1",
    timingManifest: {
      renderedAssetChecksum: checksum,
      scenes: [scene(1, 0, 4000), scene(2, 4000, 9000)],
    },
    qualityReport: quality(),
    rendererVersion: 1,
    ...overrides,
  }) as LongFormRender;

const setup = (
  options: { render?: LongFormRender | null; reply?: unknown; reviewerError?: Error } = {},
) => {
  const recorded: unknown[] = [];
  const reviewer = {
    review: vi.fn(async () => {
      if (options.reviewerError) throw options.reviewerError;
      return options.reply ?? { verdict: "ok", issues: [] };
    }),
  };
  const extractFrames = vi.fn(async (_video: Uint8Array, times: readonly number[]) =>
    times.map(() => new Uint8Array([1])),
  );
  const deps: ReviewFramesDependencies = {
    renders: {
      findForWorkspace: async () => (options.render === undefined ? render() : options.render),
      recordVisualReview: async (input) => {
        recorded.push(input.visual);
        return render();
      },
    },
    assets: {
      findForWorkspace: async () =>
        ({ id: "asset-1", workspaceId, state: "active", mimeType: "video/mp4", checksum }) as never,
    },
    store: { createDownload: async () => ({ url: "https://example.test/v.mp4" }) as never },
    fetchVideo: async () => new Uint8Array([9]),
    extractFrames,
    reviewer,
    model: "qwen3-vl-4b",
  };
  const run = () =>
    createReviewFramesHandler(deps)({
      payload: { version: 1, workspaceId, identifiers: { renderId: "render-1" } },
    });
  return { run, recorded, reviewer, extractFrames };
};

describe("review_frames handler", () => {
  it("reviews a hook frame and one frame per scene and keeps the BLOCK", async () => {
    const { run, recorded, extractFrames } = setup({
      reply: { verdict: "issue", issues: [{ kind: "clutter", severity: "warn", note: "busy" }] },
    });
    await run();
    expect(extractFrames.mock.calls[0]?.[1]).toEqual([500, 2000, 6500]);
    const visual = recorded[0] as { findings: { id: string; severity: string }[]; vlm: unknown };
    expect(visual.findings[0]).toMatchObject({ id: "caption_contrast", severity: "BLOCK" });
    expect(visual.findings.filter((entry) => entry.id === "vlm_clutter")).toHaveLength(3);
    expect(visual.vlm).toMatchObject({ vlm: "reviewed", model: "qwen3-vl-4b", frames: 3 });
  });

  it("records vlm skipped and succeeds when the reviewer is down", async () => {
    const { run, recorded } = setup({ reviewerError: new Error("frame_reviewer_http_503") });
    await run();
    expect(recorded[0]).toMatchObject({
      findings: [{ id: "caption_contrast", severity: "BLOCK", sceneIndex: 1 }],
      vlm: { vlm: "skipped", reason: "reviewer_unavailable" },
    });
  });

  it("does not review a render twice", async () => {
    const reviewed = render({
      qualityReport: quality({
        visual: { findings: [], colorStrip: [], vlm: { vlm: "reviewed" } },
      }),
    });
    const { run, reviewer } = setup({ render: reviewed });
    await run();
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("fails permanently for a render that is missing, not ready or has no report", async () => {
    for (const row of [
      null,
      render({ status: "pending" }),
      { ...render(), qualityReport: undefined } as unknown as LongFormRender,
    ]) {
      const { run, reviewer } = setup({ render: row });
      await expect(run()).rejects.toThrow(PermanentJobError);
      expect(reviewer.review).not.toHaveBeenCalled();
    }
  });
});

describe("keyFramePlan and the job envelope", () => {
  it("puts the hook first and never past the first scene", () => {
    expect(keyFramePlan([scene(1, 0, 300)]).map((entry) => entry.timeMs)).toEqual([299, 150]);
    expect(keyFramePlan([])).toEqual([]);
  });

  it("carries only ids and dedupes per render", () => {
    const job = createReviewFramesJob({ workspaceId, renderId: "render-1" });
    expect(job.payload.identifiers).toEqual({ renderId: "render-1" });
    expect(job.idempotencyKey).toBe("review-frames:render-1");
  });
});
