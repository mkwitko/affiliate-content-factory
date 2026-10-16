import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Storyboard } from "../content/storyboard.js";
import type { EnqueueJobInput } from "../jobs/job.js";
import {
  createGenerateSceneClipsJob,
  type LongFormRender,
  type LongFormRenderRepository,
  requestLongFormRender,
} from "./long-form-render.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const renderId = "33333333-3333-4333-8333-333333333333";
const board = (renderer: Storyboard["renderer"]) =>
  ({ id: "board-1", workspaceId, renderer }) as unknown as Storyboard;
const renders = (created: boolean): Pick<LongFormRenderRepository, "createPending"> => ({
  createPending: async (input) => ({
    created,
    render: {
      id: input.id,
      workspaceId,
      storyboardId: input.storyboardId,
      attempt: 2,
      status: "pending",
      rendererVersion: 1,
    } as LongFormRender,
  }),
});
const request = async (renderer: Storyboard["renderer"], created = true) => {
  const jobs: EnqueueJobInput[] = [];
  await requestLongFormRender({
    workspaceId,
    storyboard: board(renderer),
    renderId,
    rendererVersion: 1,
    renders: renders(created) as LongFormRenderRepository,
    jobs: { enqueue: async (job) => (jobs.push(job), {} as never) },
  });
  return jobs;
};

describe("requestLongFormRender", () => {
  it("enqueues render_long_form for every renderer except ai_clips", async () => {
    for (const renderer of ["slideshow", "stickman_still", "stickman_motion"] as const)
      expect((await request(renderer)).map((job) => job.name)).toEqual(["render_long_form"]);
  });
  it("starts an ai_clips render with generate_scene_clips, which enqueues the render later", async () => {
    const jobs = await request("ai_clips");
    expect(jobs.map((job) => job.name)).toEqual(["generate_scene_clips"]);
    expect(jobs[0]).toMatchObject({
      payload: { version: 1, workspaceId, identifiers: { renderId } },
      idempotencyKey: `scene-clips:${renderId}:2`,
      attemptPolicy: { maxAttempts: 600 },
    });
  });
  it("enqueues nothing when the render already existed", async () => {
    expect(await request("ai_clips", false)).toEqual([]);
  });
  it("keeps the job payload inside the queue's identifier envelope", () => {
    const job = createGenerateSceneClipsJob({ workspaceId, renderId, attempt: 1 });
    expect(JSON.stringify(job.payload).length).toBeLessThan(1024);
  });
});
