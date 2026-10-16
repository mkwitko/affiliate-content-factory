import type { WorkspaceId } from "@money-maker/contracts";

/**
 * Home worker tokens (ADR 0012): the only credential a home machine holds. Random, shown once,
 * stored as a hash, bound to one workspace and a capability list, revocable.
 */
export const HOME_CAPABILITIES = [
  "scene_director",
  "image_generation",
  "visual_qa",
  "copywriting",
  "video_generation",
  "image_editing",
  "speech_recognition",
] as const;
export type HomeCapability = (typeof HOME_CAPABILITIES)[number];
/** The local-AI jobs each capability serves. */
export const CAPABILITY_JOBS: Readonly<Record<HomeCapability, readonly string[]>> = Object.freeze({
  scene_director: ["direct_scenes"],
  image_generation: ["generate_plates"],
  visual_qa: ["review_frames", "check_scene_fidelity"],
  copywriting: ["draft_offer_copy"],
  video_generation: ["generate_clips"],
  image_editing: ["generate_offer_scenes"],
  speech_recognition: ["check_narration"],
});
export type RuntimeState = "stopped" | "starting" | "healthy" | "failed";
/** What a home machine reports each poll round: no commands, paths or environment. */
export type HomeWorkerHeartbeat = Readonly<{
  capabilities: readonly HomeCapability[];
  busy: HomeCapability | null;
  runtimes: Readonly<Record<string, RuntimeState>>;
  lastCompletedAt: string | null;
  lastFailureCode: string | null;
}>;
export const HOME_TOKEN_PREFIX = "mmhw_";

export type HomeWorkerToken = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  tokenHash: string;
  /** The first characters of the plain token, for operators to tell tokens apart. */
  prefix: string;
  capabilities: readonly HomeCapability[];
  createdById: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  heartbeat?: HomeWorkerHeartbeat | null;
  heartbeatAt?: Date | null;
}>;

export interface HomeWorkerTokenRepository {
  create(token: HomeWorkerToken): Promise<HomeWorkerToken>;
  findByHash(tokenHash: string): Promise<HomeWorkerToken | null>;
  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly HomeWorkerToken[]>;
  revoke(input: {
    workspaceId: WorkspaceId;
    id: string;
    at: Date;
  }): Promise<HomeWorkerToken | null>;
  touch(input: { id: string; at: Date }): Promise<void>;
  recordHeartbeat(input: { id: string; at: Date; heartbeat: HomeWorkerHeartbeat }): Promise<void>;
}

export type TokenDeps = Readonly<{
  random: () => string;
  hash: (plain: string) => Promise<string>;
  now: () => Date;
  id: () => string;
}>;

export const issueHomeWorkerToken = async (
  repository: Pick<HomeWorkerTokenRepository, "create">,
  deps: TokenDeps,
  input: Readonly<{
    workspaceId: WorkspaceId;
    name: string;
    capabilities: readonly HomeCapability[];
    createdById: string;
  }>,
): Promise<Readonly<{ plain: string; token: HomeWorkerToken }>> => {
  const capabilities = [...new Set(input.capabilities)].filter((c) =>
    (HOME_CAPABILITIES as readonly string[]).includes(c),
  );
  if (capabilities.length === 0) throw new Error("home_token_capabilities_required");
  const plain = `${HOME_TOKEN_PREFIX}${deps.random()}`;
  const token = await repository.create({
    id: deps.id(),
    workspaceId: input.workspaceId,
    name: input.name.trim().slice(0, 80) || "home worker",
    tokenHash: await deps.hash(plain),
    prefix: plain.slice(0, HOME_TOKEN_PREFIX.length + 6),
    capabilities,
    createdById: input.createdById,
    createdAt: deps.now(),
    lastUsedAt: null,
    revokedAt: null,
  });
  return { plain, token };
};

/** Bearer token → live token, or null. lastUsedAt is refreshed at most once a minute. */
export const authenticateHomeWorker = async (
  repository: Pick<HomeWorkerTokenRepository, "findByHash" | "touch">,
  deps: Pick<TokenDeps, "hash" | "now">,
  bearer: string | undefined,
): Promise<HomeWorkerToken | null> => {
  if (!bearer?.startsWith(HOME_TOKEN_PREFIX) || bearer.length < HOME_TOKEN_PREFIX.length + 32)
    return null;
  const token = await repository.findByHash(await deps.hash(bearer));
  if (!token || token.revokedAt) return null;
  const now = deps.now();
  if (!token.lastUsedAt || now.getTime() - token.lastUsedAt.getTime() > 60_000)
    await repository.touch({ id: token.id, at: now });
  return token;
};

/** The listing an operator sees: never the hash. */
export const describeToken = (token: HomeWorkerToken) => ({
  id: token.id,
  name: token.name,
  prefix: token.prefix,
  capabilities: token.capabilities,
  createdAt: token.createdAt.toISOString(),
  lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  revokedAt: token.revokedAt?.toISOString() ?? null,
  heartbeat: token.heartbeat ?? null,
  heartbeatAt: token.heartbeatAt?.toISOString() ?? null,
});
