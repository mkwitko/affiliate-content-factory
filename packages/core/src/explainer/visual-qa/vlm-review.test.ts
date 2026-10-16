import { describe, expect, it } from "vitest";
import type { VisualSection } from "../../publishing/render-quality.js";
import {
  type FrameReviewer,
  parseFrameReview,
  reviewFrames,
  type VlmFrame,
  withVlmReview,
} from "./vlm-review.js";

const frame = (sceneIndex: number, hook = false): VlmFrame => ({
  sceneIndex,
  hook,
  png: new Uint8Array([1]),
});
const scripted = (...replies: unknown[]): FrameReviewer => {
  let i = 0;
  return {
    review: async () => {
      const reply = replies[i++];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};
const ok = { verdict: "ok", issues: [] };
const clutter = {
  verdict: "issue",
  issues: [{ kind: "clutter", severity: "warn", note: "  Too many props on the right.  " }],
};

describe("parseFrameReview", () => {
  it("accepts the schema and maps severities", () => {
    expect(parseFrameReview(ok)).toEqual([]);
    expect(parseFrameReview(clutter)).toEqual([
      { kind: "clutter", severity: "WARN", note: "Too many props on the right." },
    ]);
  });

  it("rejects text, unknown kinds, a BLOCK severity and self-contradicting verdicts", () => {
    expect(parseFrameReview("looks fine")).toBeNull();
    expect(
      parseFrameReview({
        verdict: "issue",
        issues: [{ kind: "copy", severity: "warn", note: "x" }],
      }),
    ).toBeNull();
    expect(
      parseFrameReview({
        verdict: "issue",
        issues: [{ kind: "clutter", severity: "block", note: "x" }],
      }),
    ).toBeNull();
    expect(parseFrameReview({ verdict: "ok", issues: clutter.issues })).toBeNull();
    expect(parseFrameReview({ verdict: "issue", issues: [] })).toBeNull();
  });
});

describe("reviewFrames", () => {
  it("turns issues into WARN findings on the right scene and records the model", async () => {
    const result = await reviewFrames(scripted(ok, clutter), [frame(1, true), frame(2)], {
      model: "qwen3-vl-4b",
    });
    expect(result.record).toMatchObject({ vlm: "reviewed", model: "qwen3-vl-4b", frames: 2 });
    expect(result.findings).toEqual([
      {
        id: "vlm_clutter",
        severity: "WARN",
        sceneIndex: 2,
        detail: "Too many props on the right.",
      },
    ]);
  });

  it("retries an unreadable reply once, then skips that frame", async () => {
    const retried = await reviewFrames(scripted("oops", ok), [frame(1)]);
    expect(retried.record).toMatchObject({ vlm: "reviewed", frames: 1 });
    const lost = await reviewFrames(scripted("a", "b", ok), [frame(1), frame(2)]);
    expect(lost.record).toMatchObject({ vlm: "reviewed", frames: 1, unreadableFrames: 1 });
  });

  it("records vlm skipped when the reviewer is down or never readable", async () => {
    expect(
      (await reviewFrames(scripted(new Error("scene_reviewer_http_503")), [frame(1)])).record,
    ).toMatchObject({
      vlm: "skipped",
      reason: "reviewer_unavailable",
    });
    expect((await reviewFrames(scripted("a", "b"), [frame(1)])).record).toMatchObject({
      vlm: "skipped",
      reason: "reply_invalid",
    });
    expect((await reviewFrames(scripted(), [])).record).toMatchObject({
      vlm: "skipped",
      reason: "no_frames",
    });
  });
});

describe("withVlmReview", () => {
  const section: VisualSection = {
    findings: [{ id: "caption_contrast", severity: "BLOCK", sceneIndex: 1 }],
    colorStrip: ["#112233"],
  };

  it("never clears or softens a deterministic BLOCK, whatever the VLM says", async () => {
    const result = await reviewFrames(scripted(ok), [frame(1)]);
    const merged = withVlmReview(section, result);
    expect(merged.findings).toContainEqual({
      id: "caption_contrast",
      severity: "BLOCK",
      sceneIndex: 1,
    });
    expect(merged.vlm).toMatchObject({ vlm: "reviewed" });
  });

  it("only appends INFO or WARN findings", async () => {
    const result = await reviewFrames(scripted(clutter), [frame(2)]);
    const merged = withVlmReview(section, result);
    expect(merged.findings.slice(1).every((entry) => entry.severity !== "BLOCK")).toBe(true);
    expect(merged.findings).toHaveLength(2);
  });
});
