import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { McpDependencies } from "../server.js";
import { inspectSourceTranscriptTool } from "./inspect-source-transcript.js";

const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");

const dependencies = (role: "owner" | "viewer" = "owner") =>
  ({
    workspaces: {
      findMembership: async () =>
        role === "viewer" ? null : { workspaceId, userId, role, status: "active" },
    },
  }) as unknown as McpDependencies;

describe("inspect_source_transcript", () => {
  it("normalizes supplied transcript cues without persistence", async () => {
    const result = await inspectSourceTranscriptTool(
      {
        workspaceId,
        format: "vtt",
        transcript: "WEBVTT\n\n00:00:01.200 --> 00:00:02.500\nA useful moment.",
      },
      userId,
      dependencies(),
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        format: "vtt",
        persisted: false,
        cues: [{ startMs: 1200, endMs: 2500, text: "A useful moment." }],
      },
    });
  });

  it("requires workspace access and reports malformed input clearly", async () => {
    await expect(
      inspectSourceTranscriptTool(
        { workspaceId, transcript: "hello" },
        userId,
        dependencies("viewer"),
      ),
    ).resolves.toEqual({ ok: false, error: "FORBIDDEN" });

    await expect(
      inspectSourceTranscriptTool(
        { workspaceId, format: "srt", transcript: "00:00:03,000 --> 00:00:02,000\nBad" },
        userId,
        dependencies(),
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_TRANSCRIPT" });
  });

  it("rejects oversized transcript before parsing", async () => {
    await expect(
      inspectSourceTranscriptTool(
        { workspaceId, transcript: "x".repeat(120_001) },
        userId,
        dependencies(),
      ),
    ).resolves.toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
