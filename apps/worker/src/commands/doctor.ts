// apps/worker/src/commands/doctor.ts
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isPrivateRuntimeHost } from "@money-maker/config";
import {
  type GenerationPolicy,
  parseGenerationPolicy,
} from "@money-maker/core/assets/generation-policy";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import {
  type CapabilityHealth,
  evaluateCapabilities,
  type Observation,
} from "@money-maker/core/capabilities/capability-health";
import { agnesApiKeyFor, localVideoFor } from "../scene-generator.js";

/** Bounded, secret-free environment doctor. Never throws: every probe failure becomes a state. */
type Env = Readonly<Record<string, string | undefined>>;
export type DoctorHomeToken = Readonly<{
  heartbeatAt: Date | null;
  capabilities: readonly string[];
  runtimes: Readonly<Record<string, string>>;
}>;
/** Only counts and heartbeat metadata: no secret reference or token hash ever crosses this interface. */
export type DoctorDatabase = Readonly<{
  ping(): Promise<void>;
  activeConnections(workspaceId?: string): Promise<Readonly<Record<string, number>>>;
  homeTokens(workspaceId?: string): Promise<readonly DoctorHomeToken[]>;
}>;
export type DoctorDeps = Readonly<{
  env: Env;
  now: () => Date;
  fetch: typeof fetch;
  hasBinary: (name: "ffmpeg" | "ffprobe") => Promise<boolean>;
  fontsPresent: () => boolean;
  hyperframesPresent: () => Promise<boolean>;
  verifiedModels: (dir: string) => Promise<readonly string[]>;
  database?: DoctorDatabase;
}>;
export type DoctorArgs = Readonly<{
  json: boolean;
  strict: boolean;
  workspace: string | undefined;
}>;
export type DoctorRow = Readonly<{ group: string; label: string; status: string; detail: string }>;
export type DoctorReport = Readonly<{
  rows: readonly DoctorRow[];
  capabilities: readonly CapabilityHealth[];
  strictFailure: boolean;
}>;

const HOME_ONLINE_MS = 5 * 60 * 1000;
const PROBE_MS = 3_000;
const execFileAsync = promisify(execFile);

export const parseDoctorArgs = (argv: readonly string[]): DoctorArgs => {
  let json = false;
  let strict = false;
  let workspace: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--json") json = true;
    else if (arg === "--strict") strict = true;
    else if (arg === "--workspace") {
      i += 1;
      workspace = argv[i];
    } else if (arg.startsWith("--workspace=")) workspace = arg.slice("--workspace=".length);
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (workspace !== undefined && !workspace) throw new Error("invalid_workspace");
  return { json, strict, workspace };
};

/** Never returns the URL: only where it points, so logs cannot carry credentials or hosts. */
export const classifyUrl = (value: string): string => {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "invalid";
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return `loopback:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
    return isPrivateRuntimeHost(url.hostname) ? "private" : "public";
  } catch {
    return "invalid";
  }
};

const bounded = async <T>(work: () => Promise<T>, ms = PROBE_MS): Promise<T | undefined> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

const row = (group: string, label: string, status: string, detail = ""): DoctorRow => ({
  group,
  label,
  status,
  detail,
});

type Runtime = Readonly<{ observation: Observation; status: string; detail: string }>;
const NOT_CONFIGURED: Runtime = {
  observation: { state: "unconfigured", reason: "not configured" },
  status: "NOT CONFIGURED",
  detail: "",
};

/** HTTP GET only to loopback or private hosts; any answer below 500 means the runtime is up. */
const probeUrl = async (deps: DoctorDeps, key: string, path: string): Promise<Runtime> => {
  const value = deps.env[key]?.trim();
  if (!value) return NOT_CONFIGURED;
  const where = classifyUrl(value);
  if (!where.startsWith("loopback") && where !== "private")
    return {
      observation: { state: "offline", reason: `${where} host is never probed` },
      status: "OFFLINE",
      detail: `${where}, not probed`,
    };
  const up = await bounded(async () => {
    const response = await deps.fetch(new URL(path, value), {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    return response.status < 500;
  });
  return up
    ? { observation: { state: "ok", reason: "healthy" }, status: "HEALTHY", detail: where }
    : {
        observation: { state: "offline", reason: "no answer" },
        status: "OFFLINE",
        detail: where,
      };
};

const modelLabel = (id: string | undefined, fallback: string): string =>
  id && modelPolicyFor(id) ? id : fallback;

export const runDoctor = async (deps: DoctorDeps, args: DoctorArgs): Promise<DoctorReport> => {
  const { env } = deps;
  const rows: DoctorRow[] = [];
  const observations: Record<string, Observation> = {};
  let policy: GenerationPolicy = "cloud_allowed";
  let policyDetail = "";
  try {
    policy = parseGenerationPolicy(env.GENERATION_POLICY);
    policyDetail = env.GENERATION_POLICY?.trim() ? policy : `${policy} (default)`;
  } catch {
    policyDetail = "invalid; treated as cloud_allowed";
  }

  // Core
  let dbOk = false;
  const database = deps.database;
  if (!env.DATABASE_URL || !database) {
    rows.push(row("Core", "Database", "NOT CONFIGURED"));
  } else {
    dbOk = (await bounded(() => database.ping().then(() => true))) === true;
    rows.push(
      row(
        "Core",
        "Database",
        dbOk ? "HEALTHY" : "OFFLINE",
        args.workspace ? "workspace-scoped" : "all workspaces, counts only",
      ),
    );
  }
  const r2Set = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter(
    (key) => env[key]?.trim(),
  ).length;
  rows.push(
    row(
      "Core",
      "R2",
      r2Set === 4 ? "CONFIGURED" : r2Set === 0 ? "NOT CONFIGURED" : "FAILED",
      r2Set === 4 ? "not probed" : r2Set === 0 ? "" : "partial configuration",
    ),
  );

  // Commerce: connection rows only, counted, never read.
  const counts =
    dbOk && database ? await bounded(() => database.activeConnections(args.workspace)) : undefined;
  for (const [label, key, id] of [
    ["Mercado Livre", "mercado_livre", "mercado_livre"],
    ["Post for Me", "post_for_me", "post_for_me"],
  ] as const) {
    const count = counts?.[key] ?? 0;
    const state: Observation = !env.DATABASE_URL
      ? { state: "unconfigured", reason: "database not configured" }
      : !counts
        ? { state: "offline", reason: "database unavailable" }
        : count > 0
          ? { state: "ok", reason: `${count} active connection(s)` }
          : { state: "unconfigured", reason: "no active connection" };
    observations[id] = state;
    rows.push(
      row(
        "Commerce",
        label,
        state.state === "ok" ? "HEALTHY" : state.state === "offline" ? "OFFLINE" : "NOT CONFIGURED",
        counts ? `${count} active` : "",
      ),
    );
  }

  // Local AI
  const tokens =
    dbOk && database ? ((await bounded(() => database.homeTokens(args.workspace))) ?? []) : [];
  const online = tokens.filter(
    (token) =>
      token.heartbeatAt !== null &&
      deps.now().getTime() - token.heartbeatAt.getTime() < HOME_ONLINE_MS,
  );
  const homeServes = (capability: string): boolean =>
    online.some(
      (token) =>
        token.capabilities.includes(capability) &&
        (token.runtimes[capability] === undefined || token.runtimes[capability] === "healthy"),
    );
  rows.push(
    tokens.length === 0
      ? row("Local AI", "home-worker", "NOT CONFIGURED", env.DATABASE_URL ? "no tokens" : "")
      : row(
          "Local AI",
          "home-worker",
          online.length > 0 ? "ONLINE" : "OFFLINE",
          `${online.length}/${tokens.length} tokens with a heartbeat under 5 min`,
        ),
  );
  const home = (id: string, capability: string) => {
    observations[id] = homeServes(capability)
      ? { state: "ok", reason: "home worker healthy" }
      : { state: online.length > 0 ? "offline" : "unconfigured", reason: "no healthy home worker" };
  };
  home("home_worker:scene_director", "scene_director");
  home("home_worker:copywriting", "copywriting");
  home("home_worker:visual_qa", "visual_qa");
  home("home_worker:image_editing", "image_editing");

  const addRuntime = (label: string, result: Runtime, ...ids: string[]): void => {
    for (const id of ids)
      if (result.observation.state !== "unconfigured" || !observations[id])
        observations[id] = result.observation;
    rows.push(row("Local AI", label, result.status, result.detail));
  };
  addRuntime(
    "Scene Director",
    await probeUrl(deps, "SCENE_DIRECTOR_URL", "/health"),
    "local:scene-director",
  );
  addRuntime("Copywriting", await probeUrl(deps, "COPYWRITER_URL", "/health"), "local:copywriter");
  const imageGen = await probeUrl(deps, "IMAGE_GEN_URL", "/health");
  addRuntime("Image Generation", imageGen);
  if (imageGen.observation.state === "ok" || !observations["home_worker:sd.cpp"])
    observations["home_worker:sd.cpp"] = homeServes("image_generation")
      ? { state: "ok", reason: "pending_review" }
      : imageGen.observation.state === "ok"
        ? { state: "ok", reason: "pending_review" }
        : imageGen.observation;
  observations["local:command_generator"] =
    env.SCENE_GENERATOR_CMD?.trim() && env.SCENE_GENERATOR_MODEL?.trim()
      ? { state: "ok", reason: "command configured" }
      : { state: "unconfigured", reason: "SCENE_GENERATOR_CMD not set" };
  observations["workers_ai:flux-1-schnell"] =
    env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN && env.CLOUDFLARE_AI_GATEWAY
      ? { state: "ok", reason: "configured" }
      : { state: "unconfigured", reason: "Cloudflare not configured" };
  const edit = await probeUrl(deps, "IMAGE_EDIT_URL", "/health");
  rows.push(row("Local AI", "Image Editing", edit.status, edit.detail));
  const video = await probeUrl(deps, "VIDEO_GEN_URL", "/health");
  const wanOn = localVideoFor(env);
  observations["local:wan2.2-ti2v-5b"] = !wanOn
    ? { state: "disabled", reason: "needs LOCAL_VIDEO_ENABLED and an enabled model policy" }
    : video.observation;
  rows.push(
    row(
      "Local AI",
      "Wan Video",
      wanOn ? video.status : "DISABLED",
      wanOn ? video.detail : modelLabel(env.VIDEO_GEN_MODEL, "default model"),
    ),
  );
  observations.agnes_hosted = agnesApiKeyFor(env)
    ? { state: "ok", reason: "key present" }
    : { state: "unconfigured", reason: "AGNES_API_KEY not set" };
  addRuntime("Qwen-VL", await probeUrl(deps, "FRAME_REVIEWER_URL", "/health"), "local:qwen-vl");
  addRuntime("Kokoro", await probeUrl(deps, "TTS_URL", "/v1/audio/voices"), "local:kokoro");
  const modelsDir = env.LOCAL_MODELS_DIR?.trim();
  const verified = modelsDir
    ? ((await bounded(() => deps.verifiedModels(modelsDir), 10_000)) ?? [])
    : [];
  observations["local:realesrgan-ncnn-vulkan"] = verified.includes("upscale")
    ? { state: "ok", reason: "models verified" }
    : {
        state: "unconfigured",
        reason: modelsDir ? "models not verified" : "LOCAL_MODELS_DIR not set",
      };
  rows.push(
    row("Local AI", "Upscale", verified.includes("upscale") ? "HEALTHY" : "NOT CONFIGURED"),
  );

  // Render
  const [ffmpeg, ffprobe] = await Promise.all([
    deps.hasBinary("ffmpeg"),
    deps.hasBinary("ffprobe"),
  ]);
  const fonts = deps.fontsPresent();
  observations.ffmpeg_svg_motion =
    ffmpeg && ffprobe && fonts
      ? { state: "ok", reason: "ffmpeg, ffprobe and fonts present" }
      : { state: "offline", reason: "ffmpeg, ffprobe or fonts missing" };
  rows.push(
    row(
      "Render",
      "stickman_motion",
      ffmpeg && ffprobe && fonts ? "HEALTHY" : "FAILED",
      `ffmpeg ${ffmpeg ? "yes" : "no"}, ffprobe ${ffprobe ? "yes" : "no"}, fonts ${fonts ? "yes" : "no"}`,
    ),
  );
  const hyper = (await bounded(() => deps.hyperframesPresent(), 10_000)) === true;
  observations.hyperframes_cli = hyper
    ? { state: "ok", reason: "cli cached" }
    : { state: "unconfigured", reason: "hyperframes@0.8.112 not installed" };
  rows.push(
    row(
      "Render",
      "HyperFrames",
      hyper ? "EXPERIMENTAL" : "NOT CONFIGURED",
      "never installed from the network",
    ),
  );

  // Policy
  rows.push(row("Policy", "generation policy", policy.toUpperCase(), policyDetail));
  rows.push(
    row(
      "Policy",
      "autonomy",
      env.AUTONOMY_ENABLED !== "false" ? "ENABLED" : "DISABLED",
      "AUTONOMY_ENABLED worker loop",
    ),
  );

  // Autonomy
  rows.push(
    row(
      "Autonomy",
      "Paperclip",
      env.PAPERCLIP_URL?.trim() ? "CONFIGURED" : "NOT CONFIGURED",
      "presence only",
    ),
  );

  return {
    rows,
    capabilities: evaluateCapabilities(observations, policy),
    strictFailure: rows.find((entry) => entry.label === "Database")?.status !== "HEALTHY",
  };
};

export const formatDoctor = (report: DoctorReport): string => {
  const lines: string[] = [];
  let group = "";
  for (const entry of report.rows) {
    if (entry.group !== group) {
      group = entry.group;
      lines.push("", group);
    }
    lines.push(
      `  ${entry.label.padEnd(18)} ${entry.status}${entry.detail ? `  (${entry.detail})` : ""}`,
    );
  }
  lines.push("", "Fallback order");
  for (const capability of report.capabilities) {
    lines.push(`  ${capability.capability}`);
    capability.backends.forEach((backend, index) => {
      const state =
        backend.state === "ok"
          ? backend.reason === "always available"
            ? "available"
            : "healthy"
          : backend.state;
      const why =
        backend.state === "ok" || backend.reason === backend.state ? "" : `  ${backend.reason}`;
      lines.push(`    ${index + 1}. ${backend.id.padEnd(32)} ${state}${why}`);
    });
  }
  return lines.join("\n").trimStart();
};

const realDeps = async (): Promise<DoctorDeps> => {
  const env = process.env;
  const hasBinary = (name: "ffmpeg" | "ffprobe") =>
    execFileAsync(name, ["-version"], { timeout: PROBE_MS }).then(
      () => true,
      () => false,
    );
  const { assertFontsPresent } = await import("@money-maker/providers/media/fonts");
  const { verifyModels } = await import("./verify-models.js");
  let database: DoctorDatabase | undefined;
  if (env.DATABASE_URL) {
    const { createDatabaseClient } = await import("@money-maker/providers/database/client");
    const client = createDatabaseClient(env.DATABASE_URL);
    const where = (workspaceId?: string) => (workspaceId ? { workspaceId } : {});
    database = {
      ping: async () => void (await client.$queryRaw`SELECT 1`),
      activeConnections: async (workspaceId) => {
        const groups = await client.providerConnection.groupBy({
          by: ["provider"],
          where: { status: "ACTIVE", ...where(workspaceId) },
          _count: { _all: true },
        });
        return Object.fromEntries(groups.map((g) => [g.provider.toLowerCase(), g._count._all]));
      },
      homeTokens: async (workspaceId) =>
        (
          await client.homeWorkerToken.findMany({
            where: { revokedAt: null, ...where(workspaceId) },
            select: { heartbeatAt: true, capabilities: true, heartbeat: true },
          })
        ).map((token) => ({
          heartbeatAt: token.heartbeatAt,
          capabilities: token.capabilities,
          runtimes:
            (token.heartbeat as { runtimes?: Record<string, string> } | null)?.runtimes ?? {},
        })),
    };
  }
  return {
    env,
    now: () => new Date(),
    fetch,
    hasBinary,
    fontsPresent: () => {
      try {
        assertFontsPresent();
        return true;
      } catch {
        return false;
      }
    },
    // --no-install: a missing CLI fails fast instead of downloading anything.
    hyperframesPresent: () =>
      execFileAsync("npx", ["--no-install", "hyperframes@0.8.112", "--version"], {
        timeout: 10_000,
        env: { ...env, npm_config_offline: "true" },
      }).then(
        () => true,
        () => false,
      ),
    verifiedModels: async (dir) => (await verifyModels(dir, env.WORKER_MACHINE_KIND)).verified,
    ...(database ? { database } : {}),
  };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseDoctorArgs(process.argv.slice(2));
  const report = await runDoctor(await realDeps(), args);
  console.log(
    args.json
      ? JSON.stringify({ rows: report.rows, capabilities: report.capabilities })
      : formatDoctor(report),
  );
  process.exit(args.strict && report.strictFailure ? 1 : 0);
}
