import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { buildRenderTimingManifest } from "@money-maker/core/publishing/render-timing-manifest";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import {
  recordOwnedClipCandidatesTool,
  suggestOwnedClipCandidatesTool,
} from "./owned-clip-candidates.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspace = "e01d9bec-b22f-45f1-85fc-3efa7162b7ca";

// 6 scenes of 10 s, one word per second.
const timed: {
  text: string;
  fromChar: number;
  toChar: number;
  startMs: number;
  endMs: number;
  sceneIndex: number;
}[] = [];
const sceneList: {
  index: number;
  fromChar: number;
  toChar: number;
  startMs: number;
  endMs: number;
  sourceAssetId: string;
  sourceAssetChecksum: string;
}[] = [];
const parts: string[] = [];
let char = 0;
for (let s = 0; s < 6; s += 1) {
  const from = char;
  for (let w = 0; w < 10; w += 1) {
    const text = `s${s}w${w}`;
    parts.push(text);
    timed.push({
      text,
      fromChar: char,
      toChar: char + text.length,
      startMs: s * 10_000 + w * 1000,
      endMs: s * 10_000 + w * 1000 + 800,
      sceneIndex: s + 1,
    });
    char += text.length + 1;
  }
  sceneList.push({
    index: s + 1,
    fromChar: from,
    toChar: char,
    startMs: s * 10_000,
    endMs: s * 10_000 + 9_800,
    sourceAssetId: `a${s}`,
    sourceAssetChecksum: "d".repeat(64),
  });
}
const body = `${parts.join(" ")} `;
const script = { id: "script-1", workspaceId, status: "approved", body, checksum: "b".repeat(64) };
const manifest = buildRenderTimingManifest({
  workspaceId,
  renderId: "render-1",
  storyboardId: "board-1",
  storyboardChecksum: "a".repeat(64),
  scriptId: script.id,
  scriptChecksum: script.checksum,
  scriptLength: body.length,
  renderedAssetId: "video-1",
  renderedAssetChecksum: "c".repeat(64),
  rendererVersion: 1,
  durationMs: 60_000,
  audioTimelineOffsetMs: 0,
  measuredAt: "2026-09-30T00:00:00.000Z",
  scenes: sceneList,
  words: timed,
});
const good = (from: number, to: number, score = 80) => ({
  fromChar: sceneList[from]?.fromChar as number,
  toChar: sceneList[to]?.toChar as number,
  title: "A title",
  hook: `s${from}w0`,
  reason: "Self-contained and useful.",
  signals: ["strong_hook"],
  score,
});

const setup = (options?: { status?: string; role?: string }) => {
  let metadata: Record<string, unknown> = { role: "long_form_video" };
  const asset = () => ({
    id: "video-1",
    workspaceId,
    state: "active",
    mimeType: "video/mp4",
    checksum: "c".repeat(64),
    metadata,
  });
  const deps = {
    workspaces: {
      findMembership: async ({ workspaceId: requested }: { workspaceId: string }) =>
        requested === workspaceId
          ? { workspaceId, userId: actorId, role: options?.role ?? "owner", status: "active" }
          : null,
    },
    longFormRenderRepository: {
      findForWorkspace: async ({ workspaceId: requested }: { workspaceId: string }) =>
        requested === workspaceId
          ? {
              id: "render-1",
              workspaceId,
              storyboardId: "board-1",
              status: options?.status ?? "ready",
              assetId: "video-1",
              durationMs: 60_000,
              timingManifest: manifest,
            }
          : null,
    },
    editorialRepository: { findScriptForWorkspace: async () => script },
    assetRepository: {
      findForWorkspace: async () => asset(),
      updateMetadata: async ({ patch }: { patch: Record<string, unknown> }) => {
        metadata = { ...metadata, ...patch };
        return asset();
      },
    },
  } as unknown as McpDependencies;
  return { deps, stored: () => metadata.ownedClipCandidates };
};
const ids = { workspaceId, renderId: "render-1" };

describe("suggest_owned_clip_candidates", () => {
  it("returns windows, rules and the prompt version when nothing is cached", async () => {
    const { deps } = setup();
    const result = await suggestOwnedClipCandidatesTool({ ...ids, count: 4 }, actorId, deps);
    expect(result).toMatchObject({
      ok: true,
      value: { cached: false, count: 4, promptVersion: "owned-clip-candidates-v1" },
    });
    if (!result.ok) return;
    expect((result.value as { windows: unknown[] }).windows).toHaveLength(1);
  });

  it("refuses unknown fields, out-of-range counts, a non-ready render and another workspace", async () => {
    const { deps } = setup();
    expect(await suggestOwnedClipCandidatesTool({ ...ids, count: 9 }, actorId, deps)).toMatchObject(
      { ok: false },
    );
    expect(await suggestOwnedClipCandidatesTool({ ...ids, extra: 1 }, actorId, deps)).toMatchObject(
      { ok: false },
    );
    expect(
      await suggestOwnedClipCandidatesTool(
        { workspaceId: otherWorkspace, renderId: "render-1" },
        actorId,
        deps,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await suggestOwnedClipCandidatesTool(ids, actorId, setup({ status: "pending" }).deps),
    ).toMatchObject({ ok: false, error: "CLIP_TIMING_UNAVAILABLE" });
  });
});

describe("record_owned_clip_candidates", () => {
  const record = (
    deps: McpDependencies,
    candidates: unknown[],
    promptVersion = "owned-clip-candidates-v1",
  ) => recordOwnedClipCandidatesTool({ ...ids, promptVersion, candidates }, actorId, deps);

  it("validates, snaps, stores and then serves the cached list", async () => {
    const { deps, stored } = setup();
    const first = await record(deps, [good(0, 3), good(4, 5, 60)]);
    expect(first).toMatchObject({ ok: true, value: { cached: false } });
    expect(stored()).toMatchObject({
      promptVersion: "owned-clip-candidates-v1",
      manifestChecksum: manifest.manifestChecksum,
    });
    const suggest = await suggestOwnedClipCandidatesTool(ids, actorId, deps);
    expect(suggest).toMatchObject({ ok: true, value: { cached: true } });
    if (!suggest.ok) return;
    expect((suggest.value as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it("is idempotent: a second record returns the stored list unchanged", async () => {
    const { deps } = setup();
    const first = await record(deps, [good(0, 3)]);
    const second = await record(deps, [good(0, 3), good(4, 5)]);
    expect(second).toMatchObject({ ok: true, value: { cached: true } });
    if (!first.ok || !second.ok) return;
    expect((second.value as { candidates: unknown[] }).candidates).toHaveLength(1);
  });

  it("refuses a prompt version that is not the current one", async () => {
    const { deps, stored } = setup();
    expect(await record(deps, [good(0, 3)], "old")).toMatchObject({
      ok: false,
      error: "INVALID_ARGUMENTS",
    });
    expect(stored()).toBeUndefined();
  });

  it("rejects extra fields, bad signals and out-of-range scores", async () => {
    const { deps } = setup();
    expect(await record(deps, [{ ...good(0, 3), extra: 1 }])).toMatchObject({ ok: false });
    expect(await record(deps, [{ ...good(0, 3), signals: ["viral"] }])).toMatchObject({
      ok: false,
    });
    expect(await record(deps, [{ ...good(0, 3), score: 101 }])).toMatchObject({ ok: false });
  });

  it("reports dropped candidates and does not cache when none survive", async () => {
    const { deps, stored } = setup();
    const result = await record(deps, [{ ...good(0, 3), hook: "nowhere" }]);
    expect(result).toMatchObject({
      ok: true,
      value: { cached: false, candidates: [], dropped: [{ index: 0, reason: "hook_not_opening" }] },
    });
    expect(stored()).toBeUndefined();
  });

  it("requires a write role", async () => {
    const { deps } = setup({ role: "reviewer" });
    expect(await record(deps, [good(0, 3)])).toMatchObject({ ok: false });
  });
});
