import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "../jobs/job.js";
import type { ReelRender } from "../publishing/reel-render.js";
import { applyNarration, buildNarrationTask, type NarrationDeps } from "./narration-task.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const sourceVariantId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const ids = { sourceVariantId, assetId };
const job: ClaimedJob = {
  id: "job-1",
  workspaceId,
  name: "check_narration",
  payload: {},
  leaseToken: "lease",
  idempotencyKey: "k",
  attemptCount: 1,
};
const render: ReelRender = {
  id: "r1",
  workspaceId,
  sourceVariantId,
  status: "ready",
  assetId,
  voiceMode: "script",
  voiceId: "pf_dora",
  qualityReport: {
    version: 1,
    verdict: "pass",
    checks: [],
    measuredAt: "2026-10-08T00:00:00.000Z",
  },
  attempt: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const MODEL = "local:parakeet-tdt-0.6b-v3";

const fixture = (overrides: { render?: Partial<ReelRender>; voiceScript?: string[] } = {}) => {
  const recordNarrationCheck = vi.fn(async () => ({ ...render }));
  const deps: NarrationDeps = {
    reels: {
      findForWorkspace: vi.fn(async () => ({ ...render, ...overrides.render })),
      recordNarrationCheck,
    },
    variants: {
      findVariantForWorkspace: vi.fn(
        async () =>
          ({
            language: "pt-BR",
            voiceScript: overrides.voiceScript ?? ["Por R$ 329,90.", "São 15% off."],
          }) as never,
      ),
    },
    assets: {
      findForWorkspace: vi.fn(
        async () => ({ id: assetId, state: "active", mimeType: "video/mp4" }) as never,
      ),
    },
    store: { createDownload: vi.fn(async () => ({ method: "GET" as const, url: "https://r2/v" })) },
    now: () => new Date("2026-10-08T12:00:00Z"),
  };
  return { deps, recordNarrationCheck };
};

describe("check_narration task", () => {
  it("hands the machine a signed video URL and the script lines", async () => {
    const { deps } = fixture();
    expect(await buildNarrationTask(deps, job, ids)).toEqual({
      kind: "check_narration",
      jobId: "job-1",
      leaseToken: "lease",
      videoUrl: "https://r2/v",
      language: "pt-BR",
      lines: ["Por R$ 329,90.", "São 15% off."],
    });
  });

  it("has nothing to do for a silent Reel, and refuses a swapped or checked render", async () => {
    expect(await buildNarrationTask(fixture({ voiceScript: [] }).deps, job, ids)).toBe("done");
    expect(
      await buildNarrationTask(fixture({ render: { voiceMode: "none" } }).deps, job, ids),
    ).toBe("done");
    await expect(
      buildNarrationTask(fixture({ render: { assetId: "other" } }).deps, job, ids),
    ).rejects.toThrow("narration_render_changed");
    await expect(
      buildNarrationTask(
        fixture({
          render: {
            qualityReport: {
              version: 1,
              verdict: "pass",
              checks: [],
              measuredAt: "2026-10-08T00:00:00.000Z",
              narration: { verdict: "pass", wer: 0, missing: [], model: MODEL, checkedAt: "x" },
            },
          },
        }).deps,
        job,
        ids,
      ),
    ).rejects.toThrow("already_checked");
  });

  it("stores a pass and a block from the compared transcript", async () => {
    const ok = fixture();
    await applyNarration(ok.deps, job, ids, {
      kind: "check_narration",
      transcript: "Por R$ 329,90. São 15% off.",
      model: MODEL,
    });
    expect(ok.recordNarrationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceVariantId,
        assetId,
        narration: expect.objectContaining({ verdict: "pass", missing: [] }),
      }),
    );
    const wrong = fixture();
    await applyNarration(wrong.deps, job, ids, {
      kind: "check_narration",
      transcript: "Por R$ 339,90. São 15% off.",
      model: MODEL,
    });
    expect(wrong.recordNarrationCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        narration: expect.objectContaining({ verdict: "block", missing: ["R$ 329,90"] }),
      }),
    );
  });

  it("accepts only the Parakeet model and a bounded transcript", async () => {
    const { deps, recordNarrationCheck } = fixture();
    await expect(
      applyNarration(deps, job, ids, {
        kind: "check_narration",
        transcript: "x",
        model: "local:qwen3-asr-1.7b",
      }),
    ).rejects.toThrow("narration_model_not_allowlisted");
    await expect(
      applyNarration(deps, job, ids, {
        kind: "check_narration",
        transcript: "x".repeat(6_001),
        model: MODEL,
      }),
    ).rejects.toThrow("narration_transcript_too_long");
    expect(recordNarrationCheck).not.toHaveBeenCalled();
  });

  it("fails when the render changed under the task", async () => {
    const { deps, recordNarrationCheck } = fixture();
    recordNarrationCheck.mockResolvedValueOnce(null as never);
    await expect(
      applyNarration(deps, job, ids, { kind: "check_narration", transcript: "x", model: MODEL }),
    ).rejects.toThrow("narration_render_changed");
  });
});
