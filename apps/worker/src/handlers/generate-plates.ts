import type { WorkspaceId } from "@money-maker/contracts";
import type { SceneBankDeps } from "@money-maker/core/creatives/scene-bank";
import { type JobIdentifierPayload, PermanentJobError } from "@money-maker/core/jobs/job";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import {
  fillSceneBank,
  type PlatePostProcessor,
  plateRequestsFor,
} from "../commands/fill-scene-bank.js";

/** One plate job per niche per UTC day; a later day may top up a plate that failed. */
export const createGeneratePlatesJob = (input: {
  workspaceId: WorkspaceId;
  nicheId: string;
  day: string;
}) => ({
  name: "generate_plates",
  payload: {
    version: 1 as const,
    workspaceId: input.workspaceId,
    identifiers: { nicheId: input.nicheId },
  },
  idempotencyKey: `generate-plates:${input.nicheId}:${input.day}`,
  attemptPolicy: { maxAttempts: 2 },
});

export type GeneratePlatesDependencies = Readonly<{
  niches: Pick<NicheRepository, "findForWorkspace">;
  /** generator is the local command generator; budget is always "generate" (no neurons). */
  bank: SceneBankDeps & Readonly<{ postProcess?: PlatePostProcessor | undefined }>;
}>;

/**
 * generate_plates (v2 slice 27): banks one wide plate per location without a pinned plate, using
 * the local image generator, the same prompt templates, post-processing and bank keys as
 * fill-scene-bank. Already-banked plates are left alone, so the job is safe to repeat.
 */
export const createGeneratePlatesHandler =
  (deps: GeneratePlatesDependencies) =>
  async (job: { payload: JobIdentifierPayload }): Promise<void> => {
    const { workspaceId, identifiers } = job.payload;
    const nicheId = identifiers.nicheId;
    if (!nicheId || !deps.bank.generator) throw new PermanentJobError("plate_job_unavailable");
    const niche = await deps.niches.findForWorkspace({ workspaceId, nicheId });
    if (niche?.state !== "active") throw new PermanentJobError("niche_unavailable");
    const requests = plateRequestsFor(niche);
    const keys = new Set(requests.map((request) => request.key));
    const result = await fillSceneBank(deps.bank, {
      workspaceId,
      niches: [niche],
      only: (request) => keys.has(request.key),
      local: true,
    });
    const missing = requests.filter(
      (request) => (result.perKey[request.key] ?? 0) < request.poolMin,
    );
    console.info("plates_generated", {
      nicheId,
      generated: result.generated,
      missing: missing.length,
    });
    if (missing.length > 0) throw new Error(`plates_missing:${missing.length}`);
  };
