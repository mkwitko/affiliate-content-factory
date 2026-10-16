export type SetupStageId =
  | "plugins"
  | "niche_research"
  | "structure"
  | "integrations"
  | "first_post"
  | "automations";

export type SetupStageStatus = "done" | "next" | "pending" | "unavailable";

export type SetupConnection = Readonly<{
  provider: "post_for_me" | "mercado_livre" | "canva";
  required: boolean;
  connected: boolean;
}>;

export type SetupStage = Readonly<{
  id: SetupStageId;
  status: SetupStageStatus;
  action: string;
  /** Present when the stage never blocks setup: it is reported but never "next". */
  optional?: true;
  /** Present on "integrations": every provider the flow can use and whether it is connected. */
  connections?: readonly SetupConnection[];
}>;

export type ComputableStageId = Exclude<SetupStageId, "plugins">;

export type SetupStageInput = Readonly<{
  id: ComputableStageId;
  complete: boolean | "unavailable";
  optional?: true;
  connections?: readonly SetupConnection[];
}>;

const pluginsStage: SetupStage = Object.freeze({
  id: "plugins",
  status: "unavailable",
  action:
    "In this ChatGPT conversation, connect the recommended plugins (Plugins -> search -> Connect): Canva, vidIQ, Hook Layer. Unsplash and Creative Production are optional. The server cannot see ChatGPT's connected plugins, so verify this yourself.",
});

const actionById: Readonly<Record<ComputableStageId, string>> = {
  niche_research: "Import at least one research snapshot and attach it to a niche.",
  structure: "Set brand context and give at least one niche and one channel their own context.",
  integrations:
    "Connect Post For Me and Mercado Livre on the dashboard: https://example.com. Canva is recommended for editable slides; connect it there too.",
  first_post: "Create an offer and content, then get it approved or published.",
  automations:
    "Optional. Create a research policy for a niche and a bounded publication policy. Setup is complete without this stage.",
};

/**
 * Sequences the stages that follow "plugins": the first required stage that is neither
 * complete nor unavailable becomes "next", every required stage after it is forced to
 * "pending", and an "unavailable" stage never consumes the "next" slot. An optional stage
 * never becomes "next" and always reports its own state (done, unavailable, or pending).
 */
export const computeSetupStages = (stages: readonly SetupStageInput[]): readonly SetupStage[] => {
  let nextAssigned = false;
  const rest = stages.map((stage): SetupStage => {
    const base = {
      id: stage.id,
      action: actionById[stage.id],
      ...(stage.optional ? { optional: true as const } : {}),
      ...(stage.connections ? { connections: stage.connections } : {}),
    };
    if (stage.optional) {
      if (stage.complete === "unavailable") return { ...base, status: "unavailable" };
      return { ...base, status: stage.complete ? "done" : "pending" };
    }
    if (nextAssigned) return { ...base, status: "pending" };
    if (stage.complete === "unavailable") return { ...base, status: "unavailable" };
    if (stage.complete) return { ...base, status: "done" };
    nextAssigned = true;
    return { ...base, status: "next" };
  });
  return Object.freeze([pluginsStage, ...rest]);
};
