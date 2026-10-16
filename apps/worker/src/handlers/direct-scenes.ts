import { randomUUID } from "node:crypto";
import type { ContentRepository } from "@money-maker/core/content/content-repository";
import { directScenes } from "@money-maker/core/content/direct-scenes";
import { directionInputFor } from "@money-maker/core/content/direction-input";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import {
  directLongForm,
  pacingBlocked,
  pacingReport,
  splitChapters,
} from "@money-maker/core/content/long-form-direction";
import { createStoryboard } from "@money-maker/core/content/storyboard";
import type { StoryboardRepository } from "@money-maker/core/content/storyboard-repository";
import type { SceneDirector } from "@money-maker/core/explainer/scene-director";
import { type JobIdentifierPayload, PermanentJobError } from "@money-maker/core/jobs/job";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";

export type DirectScenesDependencies = Readonly<{
  scripts: EditorialRepository;
  content: Pick<ContentRepository, "findContentItemForWorkspace">;
  niches: Pick<NicheRepository, "findForWorkspace">;
  storyboards: StoryboardRepository;
  director: SceneDirector;
}>;

/**
 * direct_scenes (v2 slice 26): approved script -> local director -> validated storyboard stored
 * as the next version. It is a draft only: nothing renders or publishes until the operator
 * reviews it and calls render_long_form, exactly as with a ChatGPT storyboard. A failed or
 * unreachable director leaves the ChatGPT path untouched (spec 22).
 */
export const createDirectScenesHandler =
  (deps: DirectScenesDependencies) =>
  async (job: { payload: JobIdentifierPayload }): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    const scriptId = identifiers.scriptId;
    if (!scriptId) throw new PermanentJobError("direction_script_id_missing");
    const script = await deps.scripts.findScriptForWorkspace({ workspaceId, scriptId });
    if (script?.status !== "approved") throw new PermanentJobError("script_not_approved");
    const item = await deps.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId: script.contentItemId,
    });
    const niche = item
      ? await deps.niches.findForWorkspace({ workspaceId, nicheId: item.nicheId })
      : null;
    const prepared = directionInputFor(script, niche);
    if (!prepared.ok) throw new PermanentJobError(prepared.reason);
    const { context, voiceId } = prepared;
    const longForm = context.format === "long";
    const result = await (longForm ? directLongForm : directScenes)(deps.director, prepared.input);
    if (!result.ok) {
      console.warn("scene_direction_failed", { scriptId, reason: result.reason });
      if (result.reason === "director_unavailable") throw new Error("director_unavailable");
      throw new PermanentJobError(result.reason);
    }
    if (longForm) {
      const findings = pacingReport({
        scenes: result.scenes,
        body: script.body,
        language: script.language,
        chapters: splitChapters(script.body, script.beats),
      });
      console.info("scene_direction_pacing", { scriptId, findings: findings.length });
      if (pacingBlocked(findings)) throw new PermanentJobError("pacing_blocked");
    }
    const latest = await deps.storyboards.findLatestForScript({ workspaceId, scriptId });
    await deps.storyboards.create(
      createStoryboard({
        id: randomUUID(),
        workspaceId,
        script,
        version: (latest?.version ?? 0) + 1,
        renderer: "stickman_motion",
        scenes: result.scenes,
        characters: context.characters,
        assets: [],
        voiceId,
        musicTrackId: null,
        // YouTube long-form is 16:9; short-form stays vertical.
        canvas: longForm ? "landscape" : "portrait",
        actorId: script.actorId,
        longForm,
      }),
    );
    console.info("scene_direction_drafted", { scriptId, scenes: result.scenes.length });
  };
