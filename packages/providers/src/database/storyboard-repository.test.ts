import { describe, expect, it } from "vitest";
import { storyboardFromRow } from "./storyboard-repository.js";

const row = {
  id: "board-1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  contentItemId: "item-1",
  scriptId: "script-1",
  version: 1,
  scenes: [
    { index: 1, fromChar: 0, toChar: 5, assetId: "a", motion: "static", captionMode: "word" },
  ],
  voiceId: "pf_dora",
  musicTrackId: null,
  canvas: "portrait",
  checksum: "c".repeat(64),
  createdAt: new Date(0),
  actorId: "22222222-2222-4222-8222-222222222222",
};

describe("storyboardFromRow", () => {
  it("reads the migration default as a slideshow storyboard", () => {
    expect(storyboardFromRow({ ...row, renderer: "slideshow" }).renderer).toBe("slideshow");
  });
  it("reads stickman storyboards", () => {
    expect(storyboardFromRow({ ...row, renderer: "stickman_still" }).renderer).toBe(
      "stickman_still",
    );
    expect(storyboardFromRow({ ...row, renderer: "stickman_motion" }).renderer).toBe(
      "stickman_motion",
    );
  });
  it("treats an unknown renderer value as slideshow rather than trusting it", () => {
    expect(storyboardFromRow({ ...row, renderer: "remotion" }).renderer).toBe("slideshow");
  });
});

describe("storyboardFromRow ai_clips", () => {
  it("reads ai_clips storyboards", () => {
    expect(storyboardFromRow({ ...row, renderer: "ai_clips" }).renderer).toBe("ai_clips");
  });
});
