import { z } from "zod";
import type { UserId } from "@money-maker/contracts";
import {
  computeSetupStages,
  type SetupConnection,
  type SetupStageInput,
} from "@money-maker/core/setup/setup-status";
import type { McpDependencies, ToolResult } from "../server.js";
import { authorizeWorkspaceTool, parseWorkspaceArgument } from "./workspace-access.js";

export const getSetupStatusInputSchema = z.object({ workspaceId: z.uuid() }).strict();

const readOr = async <T>(promise: Promise<T> | undefined, fallback: T): Promise<T> => {
  if (!promise) return fallback;
  try {
    return await promise;
  } catch {
    return fallback;
  }
};

export const getSetupStatusTool = async (
  args: unknown,
  actorId: UserId,
  deps: McpDependencies,
): Promise<ToolResult> => {
  const parsed = getSetupStatusInputSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: "INVALID_ARGUMENTS" };
  const workspaceId = parseWorkspaceArgument(parsed.data.workspaceId);
  if (!workspaceId) return { ok: false, error: "INVALID_ARGUMENTS" };
  const denied = await authorizeWorkspaceTool(deps, actorId, workspaceId, [
    "owner",
    "operator",
    "reviewer",
  ]);
  if (denied) return denied;

  // niche_research: at least one research snapshot attached to a niche.
  const nicheResearch: SetupStageInput = deps.researchRepository?.listForWorkspace
    ? {
        id: "niche_research",
        complete: (await readOr(deps.researchRepository.listForWorkspace(workspaceId), [])).some(
          (snapshot) => snapshot.nicheId !== null,
        ),
      }
    : { id: "niche_research", complete: "unavailable" };

  // structure: brand context set, plus at least one niche and one channel each carrying context.
  const structure: SetupStageInput =
    deps.nicheRepository?.listForWorkspace && deps.channelRepository?.listForWorkspace
      ? {
          id: "structure",
          complete:
            (await readOr(deps.workspaces.getContext?.(workspaceId), null)) !== null &&
            (await readOr(deps.nicheRepository.listForWorkspace(workspaceId), [])).some(
              (niche) => niche.context != null,
            ) &&
            (await readOr(deps.channelRepository.listForWorkspace(workspaceId), [])).some(
              (channel) => channel.context != null,
            ),
        }
      : { id: "structure", complete: "unavailable" };

  // integrations: Post For Me and an active Mercado Livre connection are required; Canva is
  // recommended for editable slides and reported so the skill can point to the dashboard.
  const integrationsStage: SetupStageInput = deps.providerConnections
    ? await (async (): Promise<SetupStageInput> => {
        const connections = await readOr(
          deps.providerConnections?.findAllForWorkspace({ workspaceId }),
          [],
        );
        const connected = (provider: SetupConnection["provider"], activeOnly: boolean) =>
          connections.some(
            (connection) =>
              connection.provider === provider && (!activeOnly || connection.status === "active"),
          );
        const report: readonly SetupConnection[] = [
          { provider: "post_for_me", required: true, connected: connected("post_for_me", false) },
          {
            provider: "mercado_livre",
            required: true,
            connected: connected("mercado_livre", true),
          },
          { provider: "canva", required: false, connected: connected("canva", true) },
        ];
        return {
          id: "integrations",
          complete: report.every((entry) => !entry.required || entry.connected),
          connections: report,
        };
      })()
    : { id: "integrations", complete: "unavailable" };

  // first_post: an offer plus a content variant that reached approved or published.
  const firstPost: SetupStageInput =
    deps.offerRepository?.listForWorkspace && deps.contentRepository?.listVariantsForWorkspace
      ? {
          id: "first_post",
          complete:
            (await readOr(deps.offerRepository.listForWorkspace(workspaceId), [])).length > 0 &&
            (await readOr(deps.contentRepository.listVariantsForWorkspace(workspaceId), [])).some(
              (variant) => variant.state === "approved" || variant.state === "published",
            ),
        }
      : { id: "first_post", complete: "unavailable" };

  // automations (optional, never blocks setup): a policy-based publication policy and at least
  // one active research policy.
  const automations: SetupStageInput =
    deps.publicationPolicyRepository && deps.researchPolicyRepository
      ? {
          id: "automations",
          optional: true,
          complete:
            (await deps.publicationPolicyRepository.findForWorkspace(workspaceId)).mode ===
              "policy_based" &&
            (await readOr(deps.researchPolicyRepository.listForWorkspace(workspaceId), [])).some(
              (policy) => policy.status !== "revoked",
            ),
        }
      : { id: "automations", optional: true, complete: "unavailable" };

  const stages = computeSetupStages([
    nicheResearch,
    structure,
    integrationsStage,
    firstPost,
    automations,
  ]);

  return { ok: true, value: { stages } };
};
