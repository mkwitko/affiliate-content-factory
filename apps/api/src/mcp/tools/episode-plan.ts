import type { UserId } from "@money-maker/contracts";
import {
  BEAT_TEMPLATES,
  buildEpisodePlan,
  lintEpisode,
  type EpisodeSpec,
} from "@money-maker/core/story/story";
import { type EpisodeRecord, noveltySignals } from "@money-maker/core/story/novelty-guard";
import { z } from "zod";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const template = z.enum(Object.keys(BEAT_TEMPLATES) as [keyof typeof BEAT_TEMPLATES]);

export const continuityFactSchema = z
  .object({
    id: text(120),
    episodeId: text(120),
    kind: z.enum([
      "relationship",
      "job",
      "location",
      "possession",
      "knowledge",
      "event",
      "gag",
      "conflict",
      "growth",
    ]),
    subject: text(120),
    predicate: text(200),
    object: text(200).optional(),
    salience: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    supersedes: text(120).optional(),
    expiresEpisode: z.number().int().min(1).optional(),
  })
  .strict();

const ideaSchema = z
  .object({
    id: text(120),
    logline: text(300),
    template,
    theme: text(120),
    castIds: z.array(text(80)).min(1).max(6),
    locationId: text(80),
    want: text(300),
    obstacle: text(300),
    twist: text(300).optional(),
    durationClass: z.enum(["short", "mid", "long"]),
    seed: z.number().int(),
  })
  .strict();
const beatSchema = z
  .object({
    id: text(120),
    kind: z.enum([
      "hook",
      "setup",
      "inciting",
      "attempt",
      "complication",
      "turn",
      "low",
      "climax",
      "resolution",
      "button",
    ]),
    link: z.enum(["therefore", "but"]).optional(),
    want: z.string().max(300),
    conflict: z.string().max(300),
    outcome: z.string().max(300),
    characterIds: z.array(text(80)).max(6),
    locationId: text(80),
    zoneId: text(80).optional(),
    targetSec: z.number().positive().max(600),
    visualEvent: z.string().max(300),
    dialogue: z
      .array(z.object({ characterId: text(80), text: text(400) }).strict())
      .max(20)
      .optional(),
  })
  .strict();
const audience = z.enum(["adult", "teen", "general"]);
const intent = z.enum(["explainer", "story", "comedy", "commerce"]);

/** Strict boundary schema for a stored plan; `lintEpisode` then decides BLOCK violations. */
export const episodeSpecSchema = z
  .object({
    id: text(120),
    seriesId: text(120),
    idea: ideaSchema,
    targetSec: z.number().positive().max(3600),
    hook: z.string().max(200),
    beats: z.array(beatSchema).min(1).max(30),
    plants: z.array(z.object({ id: text(120), beatId: text(120) }).strict()).max(10),
    pays: z.array(z.object({ plantId: text(120), beatId: text(120) }).strict()).max(10),
    colorScript: z.array(z.enum(["hook", "problem", "explain", "twist", "resolve"])).max(30),
    factsWritten: z.array(continuityFactSchema).max(50),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    targetAudience: audience,
    contentIntent: intent,
    novelty: z
      .array(
        z
          .object({
            code: text(80),
            severity: z.enum(["LOG", "WARN"]),
            detail: z.string().max(300),
          })
          .strict(),
      )
      .max(30)
      .optional(),
  })
  .strict();

// What only the script, storyboard and brand layer know about one episode (see EpisodeRecord).
const recordExtras = {
  scriptBody: z.string().max(40_000).optional(),
  cameraPattern: z.array(text(60)).max(60).optional(),
  brandSec: z.number().min(0).max(3600).optional(),
};
const recentEpisodeSchema = z.object({ episodePlan: episodeSpecSchema, ...recordExtras }).strict();

export const createEpisodePlanInputSchema = z
  .object({
    workspaceId: z.uuid(),
    episodeId: text(120),
    seriesId: text(120),
    idea: ideaSchema,
    hook: text(200),
    targetSec: z.number().positive().max(3600),
    targetAudience: audience,
    contentIntent: intent,
    // The series' last published episodes, oldest first, for the advisory novelty check.
    recent: z.array(recentEpisodeSchema).max(10).optional(),
    ...recordExtras,
    sourcedFactCount: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const toRecord = (
  spec: EpisodeSpec,
  extras: {
    scriptBody?: string | undefined;
    cameraPattern?: string[] | undefined;
    brandSec?: number | undefined;
    sourcedFactCount?: number | undefined;
  },
): EpisodeRecord => ({
  spec,
  ...(extras.scriptBody !== undefined ? { scriptBody: extras.scriptBody } : {}),
  ...(extras.cameraPattern !== undefined ? { cameraPattern: extras.cameraPattern } : {}),
  ...(extras.brandSec !== undefined ? { brandSec: extras.brandSec } : {}),
  ...(extras.sourcedFactCount !== undefined ? { sourcedFactCount: extras.sourcedFactCount } : {}),
});

/**
 * Expands a story idea through its beat template, lints it (BLOCK violations) and runs the
 * NoveltyGuard (LOG/WARN signals, stored on the plan). Nothing is persisted here.
 */
export const createEpisodePlanTool = async (
  input: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = createEpisodePlanInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, ["owner", "operator"]);
  if (denied) return denied;
  const { idea, episodeId, ...rest } = parsed.data;
  const built = buildEpisodePlan({
    id: episodeId,
    seriesId: rest.seriesId,
    idea: idea as EpisodeSpec["idea"],
    hook: rest.hook,
    targetSec: rest.targetSec,
    targetAudience: rest.targetAudience,
    contentIntent: rest.contentIntent,
  });
  const novelty = noveltySignals(
    toRecord(built, rest),
    (rest.recent ?? []).map((r) => toRecord(r.episodePlan as EpisodeSpec, r)),
  );
  const episodePlan: EpisodeSpec = { ...built, novelty };
  return {
    ok: true,
    value: { episodePlan, violations: lintEpisode(episodePlan), novelty },
  };
};
