import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import {
  CLOUD_WORKER_TOKEN_NAME,
  executorOfToken,
  homeJobRoute,
  recordHomeRun,
} from "./home-routes.js";
import type { RecordedRun } from "./route-repository.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-10-14T15:00:00Z");

describe("home job routes", () => {
  it("maps the desktop jobs to their routes and ignores others", () => {
    expect(homeJobRoute("generate_offer_scenes")).toEqual({
      task: "image.offer_scene",
      model: "flux-2-klein-4b",
    });
    expect(homeJobRoute("check_narration")?.task).toBe("asr.ptbr");
    expect(homeJobRoute("render_reel")).toBeNull();
  });

  it("records the cloud worker's runs on its own cloud routes", async () => {
    expect(homeJobRoute("generate_offer_scenes", "cloud_worker")).toEqual({
      task: "image.offer_scene",
      model: "workers-ai:flux-2-klein-4b",
    });
    expect(homeJobRoute("check_narration", "cloud_worker")).toBeNull();
    expect(executorOfToken({ name: CLOUD_WORKER_TOKEN_NAME })).toBe("cloud_worker");
    expect(executorOfToken({ name: "Desktop RX 6650 XT (WSL) + ASR" })).toBe("home_worker");
    const runs: RecordedRun[] = [];
    await recordHomeRun(
      { recordRun: async (run: RecordedRun) => void runs.push(run) },
      {
        workspaceId,
        jobName: "check_scene_fidelity",
        executor: "cloud_worker",
        outcome: "ok",
        detail: null,
        now,
      },
    );
    expect(runs[0]?.routeId).toBe("vision.qa|vercel:alibaba/qwen3-vl-instruct|cloud_worker");
  });

  it("records quota failures as a one-hour pause and other failures as technical", async () => {
    const runs: RecordedRun[] = [];
    const routes = { recordRun: async (run: RecordedRun) => void runs.push(run) };
    const base = { workspaceId, jobName: "check_scene_fidelity", now } as const;
    await recordHomeRun(routes, { ...base, outcome: "failed", detail: "home:quota_exceeded" });
    await recordHomeRun(routes, { ...base, outcome: "failed", detail: "home:runtime_down" });
    await recordHomeRun(routes, {
      ...base,
      outcome: "failed",
      detail: "home:fidelity_vlm_http_402",
    });
    await recordHomeRun(routes, { ...base, outcome: "ok", detail: null });
    expect(runs.map((run) => run.outcome)).toEqual([
      "quota_exhausted",
      "technical_failure",
      "quota_exhausted",
      "ok",
    ]);
    expect(runs[0]?.retryAfter?.toISOString()).toBe("2026-10-14T16:00:00.000Z");
    expect(runs[3]?.routeId).toBe("vision.qa|qwen3-vl-4b|home_worker");
  });

  it("never throws when the run log is down", async () => {
    const routes = {
      recordRun: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      recordHomeRun(routes, {
        workspaceId,
        jobName: "draft_offer_copy",
        outcome: "ok",
        detail: null,
        now,
      }),
    ).resolves.toBeUndefined();
  });
});
