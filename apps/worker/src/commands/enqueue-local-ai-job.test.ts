import { describe, expect, it } from "vitest";
import { localAiJobFor } from "./enqueue-local-ai-job.js";

const workspace = "11111111-1111-4111-8111-111111111111";

describe("localAiJobFor", () => {
  it("builds a generate_plates job from ids only", () => {
    expect(localAiJobFor(["generate_plates", workspace, "niche-1"], "2026-09-30")).toMatchObject({
      name: "generate_plates",
      payload: { version: 1, workspaceId: workspace, identifiers: { nicheId: "niche-1" } },
      idempotencyKey: "generate-plates:niche-1:2026-09-30",
    });
  });

  it("builds a review_frames job from ids only", () => {
    expect(localAiJobFor(["review_frames", workspace, "render-1"], "d")).toMatchObject({
      name: "review_frames",
      payload: { version: 1, workspaceId: workspace, identifiers: { renderId: "render-1" } },
      idempotencyKey: "review-frames:render-1",
    });
  });

  it("refuses an unknown kind or missing ids", () => {
    expect(() => localAiJobFor(["upscale_assets", workspace, "x"], "d")).toThrow("usage:");
    expect(() => localAiJobFor(["generate_plates", workspace], "d")).toThrow("usage:");
  });
});
