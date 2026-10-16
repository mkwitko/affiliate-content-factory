import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WorkspaceId } from "@money-maker/contracts";
import { HOME_WORKER_ONLINE_MS } from "@money-maker/core/autonomy/status";
import { CLOUD_WORKER_TOKEN_NAME } from "@money-maker/core/generation/home-routes";
import {
  DEFAULT_ROUTES,
  type GenerationRouteRepository,
} from "@money-maker/core/generation/route-repository";
import {
  type GenerationRoute,
  type RouteHealth,
  routeHealth,
} from "@money-maker/core/generation/routing";
import {
  CAPABILITY_JOBS,
  type HomeCapability,
  type HomeWorkerToken,
  type HomeWorkerTokenRepository,
  issueHomeWorkerToken,
} from "@money-maker/core/home-worker/tokens";
import type { JobCount, JobStats } from "@money-maker/core/jobs/job-stats";
import type { ProviderConnectionRepository } from "@money-maker/core/providers/provider-connection-repository";
import type { SecretStore } from "@money-maker/core/providers/secret-store";
import { createWorkersAiImageEditor } from "@money-maker/providers/cloudflare/workers-ai-image-editor";
import { fetchSafeMedia } from "@money-maker/providers/http/safe-media-fetch";
import { createLlamaServerCopywriter } from "@money-maker/providers/llm/llama-server-copywriter";
import { createLlamaServerFidelityVlm } from "@money-maker/providers/llm/llama-server-fidelity-vlm";
import { createLlamaServerFrameReviewer } from "@money-maker/providers/llm/llama-server-frame-reviewer";
import { extractKeyFrames } from "@money-maker/providers/media/extract-key-frames";
import { createHomeApi, type HomeExecutors, runHomeWorkerOnce } from "./commands/home-worker.js";

/**
 * Cloud worker (spec 2026-10-14, plan C2): the VM runs the home worker protocol for itself with
 * cloud executors, so local-AI tasks still move while the desktop is off. It takes a capability
 * only when (a) its cloud route is qualified or in qualification and healthy and (b) no home machine with that
 * capability has sent a heartbeat in the last 5 minutes: the desktop always wins. It issues its
 * own home worker token (kept in memory, revoked on change), so nothing goes in `.env`.
 */
export const CLOUD_CAPABILITY_ROUTES: Readonly<Partial<Record<HomeCapability, string>>> =
  Object.freeze({
    image_editing: "image.offer_scene|workers-ai:flux-2-klein-4b|cloud_worker",
    visual_qa: "vision.qa|vercel:alibaba/qwen3-vl-instruct|cloud_worker",
    copywriting: "llm.copy|vercel:alibaba/qwen3.8-flash|cloud_worker",
  });

const desktopOnline = (
  tokens: readonly HomeWorkerToken[],
  capability: HomeCapability,
  now: Date,
): boolean =>
  tokens.some(
    (token) =>
      token.name !== CLOUD_WORKER_TOKEN_NAME &&
      !token.revokedAt &&
      token.capabilities.includes(capability) &&
      token.heartbeatAt !== null &&
      token.heartbeatAt !== undefined &&
      now.getTime() - token.heartbeatAt.getTime() < HOME_WORKER_ONLINE_MS,
  );

/** Waiting tasks of one capability before a free cloud route helps an online desktop. */
export const OVERFLOW_BACKLOG = 3;

/**
 * Pure: the capabilities the cloud worker should serve right now. Owner order (2026-10-14): the
 * desktop for everything it can, then free cloud, then paid cloud. So with the desktop offline any
 * usable cloud route serves; with it online only a free cloud route helps, and only when at least
 * OVERFLOW_BACKLOG tasks of that capability are waiting.
 */
export const cloudCapabilities = (
  input: Readonly<{
    routes: readonly GenerationRoute[];
    health: (route: GenerationRoute) => RouteHealth;
    tokens: readonly HomeWorkerToken[];
    /** Capabilities whose cloud executor is configured (credentials present). */
    available: ReadonlySet<HomeCapability>;
    /** Tasks waiting in the queue per capability. */
    backlog?: (capability: HomeCapability) => number;
    now: Date;
  }>,
): readonly HomeCapability[] =>
  (Object.entries(CLOUD_CAPABILITY_ROUTES) as [HomeCapability, string][])
    .filter(([capability, id]) => {
      if (!input.available.has(capability)) return false;
      const route = input.routes.find((candidate) => candidate.id === id);
      // A route in qualification runs too (owner decision 2026-10-14: trial in production while
      // the desktop is off; every output still passes the gates and the owner's package review).
      if (
        !route ||
        (route.state !== "qualified" && route.state !== "qualifying") ||
        !input.health(route).usable
      )
        return false;
      if (!desktopOnline(input.tokens, capability, input.now)) return true;
      return route.cost === "always_free" && (input.backlog?.(capability) ?? 0) >= OVERFLOW_BACKLOG;
    })
    .map(([capability]) => capability)
    .sort();

export type CloudWorkerDeps = Readonly<{
  workspaces: () => Promise<readonly WorkspaceId[]>;
  tokens: Pick<HomeWorkerTokenRepository, "create" | "listForWorkspace" | "revoke">;
  routes: Pick<GenerationRouteRepository, "list" | "seed" | "recentRuns">;
  /** Queue counts, for the overflow of an online desktop onto free cloud routes. */
  jobStats?: Pick<JobStats, "countByStatus">;
  connections: Pick<ProviderConnectionRepository, "findAllForWorkspace">;
  secrets: (workspaceId: WorkspaceId) => Pick<SecretStore, "get">;
  /** Workers AI account for the scene editor (the worker's existing Cloudflare settings). */
  workersAi: Readonly<{ accountId: string; apiToken: string }> | null;
  apiUrl: URL;
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
}>;

type Session = { tokenId: string; plain: string; capabilities: string };

const gatewayKey = async (
  deps: CloudWorkerDeps,
  workspaceId: WorkspaceId,
): Promise<string | null> => {
  const connection = (await deps.connections.findAllForWorkspace({ workspaceId })).find(
    (row) => row.provider === "vercel_ai_gateway" && row.status === "active",
  );
  const raw = connection ? await deps.secrets(workspaceId).get(connection.secretReference) : null;
  if (!raw) return null;
  try {
    const apiKey = (JSON.parse(raw) as { apiKey?: unknown }).apiKey;
    return typeof apiKey === "string" ? apiKey : null;
  } catch {
    return null;
  }
};

const executorsFor = (
  deps: CloudWorkerDeps,
  apiKey: string | null,
): Readonly<{ executors: HomeExecutors; available: Set<HomeCapability> }> => {
  const available = new Set<HomeCapability>();
  const gateway = apiKey ? { apiKey } : null;
  if (deps.workersAi) available.add("image_editing");
  if (gateway) {
    available.add("visual_qa");
    available.add("copywriting");
  }
  const vlm = gateway
    ? createLlamaServerFidelityVlm({ model: "vercel:alibaba/qwen3-vl-instruct", gateway })
    : null;
  return {
    available,
    executors: {
      ...(deps.workersAi ? { editor: createWorkersAiImageEditor(deps.workersAi) } : {}),
      ...(vlm
        ? {
            fidelity: {
              compare: vlm.compare,
              reference: vlm.reference,
              model: "vercel:alibaba/qwen3-vl-instruct",
            },
          }
        : {}),
      ...(gateway
        ? {
            reviewer: {
              reviewer: createLlamaServerFrameReviewer({
                model: "vercel:alibaba/qwen3-vl-instruct",
                gateway,
              }),
              model: "vercel:alibaba/qwen3-vl-instruct",
            },
            copywriter: {
              writer: createLlamaServerCopywriter({
                model: "vercel:alibaba/qwen3.8-flash",
                gateway,
              }),
              model: "vercel:alibaba/qwen3.8-flash",
            },
          }
        : {}),
      fetchImage: async (url: string) =>
        (
          await fetchSafeMedia(new URL(url), {
            maxBytes: 10_000_000,
            allowedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
          })
        ).bytes,
      fetchVideo: async (url: string) =>
        (
          await fetchSafeMedia(new URL(url), {
            maxBytes: 250_000_000,
            allowedMimeTypes: ["video/mp4"],
          })
        ).bytes,
      extractFrames: (video, times) => extractKeyFrames(video, times),
    },
  };
};

/**
 * One round over every workspace: decide the capabilities, keep the token in step with them, and
 * run at most one task per workspace. Returns how many tasks ran. Never throws for one workspace.
 */
export const createCloudWorker = (deps: CloudWorkerDeps) => {
  const sessions = new Map<WorkspaceId, Session>();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);

  const revoke = async (workspaceId: WorkspaceId, tokens: readonly HomeWorkerToken[]) => {
    for (const token of tokens)
      if (token.name === CLOUD_WORKER_TOKEN_NAME && !token.revokedAt)
        await deps.tokens.revoke({ workspaceId, id: token.id, at: now() });
    sessions.delete(workspaceId);
  };

  const roundFor = async (workspaceId: WorkspaceId): Promise<boolean> => {
    const tokens = await deps.tokens.listForWorkspace(workspaceId);
    const owner = tokens.find((token) => token.name !== CLOUD_WORKER_TOKEN_NAME)?.createdById;
    await deps.routes.seed(workspaceId, DEFAULT_ROUTES);
    const [routes, runs] = await Promise.all([
      deps.routes.list(workspaceId),
      deps.routes.recentRuns(workspaceId, 5),
    ]);
    const { executors, available } = executorsFor(deps, await gatewayKey(deps, workspaceId));
    const pending = deps.jobStats
      ? await deps.jobStats.countByStatus({ workspaceId })
      : ([] as readonly JobCount[]);
    const backlog = (capability: HomeCapability) =>
      pending
        .filter((row) => row.status === "PENDING" && CAPABILITY_JOBS[capability].includes(row.name))
        .reduce((sum, row) => sum + row.count, 0);
    const capabilities = cloudCapabilities({
      backlog,
      routes,
      health: (route) =>
        routeHealth(
          runs.filter((run) => run.routeId === route.id),
          now(),
        ),
      tokens,
      available,
      now: now(),
    });
    const key = capabilities.join(",");
    const session = sessions.get(workspaceId);
    if (!owner || capabilities.length === 0) {
      if (session || tokens.some((t) => t.name === CLOUD_WORKER_TOKEN_NAME && !t.revokedAt))
        await revoke(workspaceId, tokens);
      return false;
    }
    let active = session;
    if (!active || active.capabilities !== key) {
      await revoke(workspaceId, tokens);
      const issued = await issueHomeWorkerToken(
        deps.tokens,
        {
          random: () => randomBytes(32).toString("base64url"),
          hash: async (plain) => createHash("sha256").update(plain).digest("hex"),
          now,
          id: randomUUID,
        },
        { workspaceId, name: CLOUD_WORKER_TOKEN_NAME, capabilities, createdById: owner },
      );
      active = { tokenId: issued.token.id, plain: issued.plain, capabilities: key };
      sessions.set(workspaceId, active);
      log("cloud_worker_capabilities", { workspaceId, capabilities });
    }
    return runHomeWorkerOnce(createHomeApi(deps.apiUrl, active.plain, deps.fetch), executors);
  };

  return {
    async round(): Promise<number> {
      let ran = 0;
      for (const workspaceId of await deps.workspaces()) {
        try {
          if (await roundFor(workspaceId)) ran += 1;
        } catch (error) {
          log("cloud_worker_round_failed", {
            workspaceId,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
      }
      return ran;
    },
    /** Revokes every token this process issued (worker shutdown). */
    async stop(): Promise<void> {
      for (const [workspaceId, session] of sessions)
        await deps.tokens
          .revoke({ workspaceId, id: session.tokenId, at: now() })
          .catch(() => undefined);
      sessions.clear();
    },
  };
};
