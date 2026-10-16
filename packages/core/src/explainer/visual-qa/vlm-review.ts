import type { RenderTimingManifest } from "../../publishing/render-timing-manifest.js";
import type { VisualFinding, VisualSection, VlmRecord } from "../../publishing/render-quality.js";

/**
 * VLM frame review (v2 slice 29, spec 17.2 and 20). Advisory only: it judges composition,
 * hierarchy, style coherence, pose readability, clutter and plate mismatch on one rasterised key
 * frame, never facts, numbers or copy. Its findings are INFO or WARN and are only ever appended
 * to a report, so a VLM "ok" can never clear a deterministic BLOCK and a VLM complaint can never
 * create one. A reviewer that is down or unreadable leaves `vlm: "skipped"` on the report.
 */
export const VLM_ISSUE_KINDS = [
  "composition",
  "hierarchy",
  "style_coherence",
  "pose_readability",
  "clutter",
  "plate_mismatch",
] as const;
export type VlmIssueKind = (typeof VLM_ISSUE_KINDS)[number];
export type VlmIssue = Readonly<{
  kind: VlmIssueKind;
  severity: "INFO" | "WARN";
  note: string;
}>;

/** One key frame, rasterised as viewers see it; `sceneIndex` is the storyboard scene index. */
export type VlmFrame = Readonly<{ sceneIndex: number; hook: boolean; png: Uint8Array }>;
/** Returns the decoded JSON reply, or the raw text when it was not JSON; throws when unreachable. */
export type FrameReviewer = Readonly<{
  review(frame: VlmFrame): Promise<unknown>;
}>;

const MAX_ISSUES = 4;
const MAX_NOTE = 140;

/** The reply schema sent as response_format.json_schema (llama.cpp turns it into a grammar). */
export const FRAME_REVIEW_JSON_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: "object",
  properties: {
    verdict: { enum: ["ok", "issue"] },
    issues: {
      type: "array",
      maxItems: MAX_ISSUES,
      items: {
        type: "object",
        properties: {
          kind: { enum: [...VLM_ISSUE_KINDS] },
          severity: { enum: ["info", "warn"] },
          note: { type: "string", maxLength: MAX_NOTE },
        },
        required: ["kind", "severity", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "issues"],
  additionalProperties: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validates one reply; null when it is not the schema or contradicts itself. */
export const parseFrameReview = (raw: unknown): readonly VlmIssue[] | null => {
  if (!isRecord(raw) || !Array.isArray(raw.issues) || raw.issues.length > MAX_ISSUES) return null;
  const issues: VlmIssue[] = [];
  for (const entry of raw.issues) {
    if (
      !isRecord(entry) ||
      !(VLM_ISSUE_KINDS as readonly unknown[]).includes(entry.kind) ||
      (entry.severity !== "info" && entry.severity !== "warn") ||
      typeof entry.note !== "string"
    )
      return null;
    issues.push({
      kind: entry.kind as VlmIssueKind,
      severity: entry.severity === "warn" ? "WARN" : "INFO",
      note: entry.note.trim().slice(0, MAX_NOTE),
    });
  }
  if (raw.verdict === "ok") return issues.length === 0 ? issues : null;
  return raw.verdict === "issue" && issues.length > 0 ? issues : null;
};

export type VlmReviewResult = Readonly<{
  record: VlmRecord;
  findings: readonly VisualFinding[];
}>;

const ATTEMPTS = 2;
const skipped = (reason: string, latencyMs: number): VlmReviewResult => ({
  record: { vlm: "skipped", reason, latencyMs },
  findings: [],
});

/**
 * Reviews each frame (one retry on an unreadable reply). An unreachable reviewer, or no readable
 * reply at all, skips the whole review; frames whose replies stay unreadable are counted.
 */
export const reviewFrames = async (
  reviewer: FrameReviewer,
  frames: readonly VlmFrame[],
  options: Readonly<{ model?: string; now?: () => number }> = {},
): Promise<VlmReviewResult> => {
  const now = options.now ?? Date.now;
  const started = now();
  if (frames.length === 0) return skipped("no_frames", 0);
  const findings: VisualFinding[] = [];
  let reviewed = 0;
  for (const frame of frames) {
    let issues: readonly VlmIssue[] | null = null;
    for (let attempt = 0; attempt < ATTEMPTS && issues === null; attempt += 1) {
      try {
        issues = parseFrameReview(await reviewer.review(frame));
      } catch {
        return skipped("reviewer_unavailable", now() - started);
      }
    }
    if (issues === null) continue;
    reviewed += 1;
    for (const issue of issues)
      findings.push({
        id: `vlm_${issue.kind}`,
        severity: issue.severity,
        sceneIndex: frame.sceneIndex,
        ...(issue.note ? { detail: issue.note } : {}),
      });
  }
  const latencyMs = now() - started;
  if (reviewed === 0) return skipped("reply_invalid", latencyMs);
  return {
    record: {
      vlm: "reviewed",
      ...(options.model ? { model: options.model } : {}),
      latencyMs,
      frames: reviewed,
      ...(reviewed < frames.length ? { unreadableFrames: frames.length - reviewed } : {}),
    },
    findings,
  };
};

/** Appends the review to a visual section; nothing already in the section is removed or softened. */
export const withVlmReview = (section: VisualSection, result: VlmReviewResult): VisualSection => ({
  ...section,
  findings: [...section.findings, ...result.findings],
  vlm: result.record,
});

/** One mid-scene frame per scene, plus an early frame of scene 1 as the hook and thumbnail. */
export const keyFramePlan = (
  scenes: RenderTimingManifest["scenes"],
): readonly Readonly<{ sceneIndex: number; hook: boolean; timeMs: number }>[] => {
  const first = scenes[0];
  if (!first) return [];
  return [
    {
      sceneIndex: first.index,
      hook: true,
      timeMs: Math.min(first.startMs + 500, Math.max(first.startMs, first.endMs - 1)),
    },
    ...scenes.map((scene) => ({
      sceneIndex: scene.index,
      hook: false,
      timeMs: Math.round((scene.startMs + scene.endMs) / 2),
    })),
  ];
};
