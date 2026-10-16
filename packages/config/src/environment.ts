import { isAbsolute } from "node:path";
import { z } from "zod";

const environmentObject = z.object({
  DATABASE_URL: z.url({
    protocol: /^postgres(?:ql)?$/,
    error: "DATABASE_URL must be a valid PostgreSQL URL",
  }),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().trim().min(1).optional(),
  // Mirrors GENERATION_POLICIES in core (config has no core dependency).
  GENERATION_POLICY: z
    .enum(["local_only", "local_first", "cloud_allowed"], { error: "generation_policy_invalid" })
    .default("cloud_allowed"),
  PUBLIC_API_URL: z.url().optional(),
  MCP_RESOURCE_URL: z.url().optional(),
  R2_ACCOUNT_ID: z.string().trim().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
  R2_BUCKET: z.string().trim().min(1).optional(),
  R2_SIGNED_URL_TTL: z.coerce.number().int().min(1).max(86_400).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().trim().min(1).optional(),
  CLOUDFLARE_API_TOKEN: z.string().trim().min(1).optional(),
  CLOUDFLARE_AI_GATEWAY: z.string().trim().min(1).optional(),
  YOUTUBE_DATA_API_KEY: z.string().trim().min(1).optional(),
  JEV_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JEV_MODE: z.enum(["shadow", "active"]).default("shadow"),
  JEV_BASE_URL: z.url({ protocol: /^https$/ }).default("https://api.typesafe.ai"),
  JEV_MODEL: z.string().trim().min(1).default("jev-latest"),
  TYPESAFE_API_KEY: z.string().trim().min(1).optional(),
  AUTH_ISSUER_URL: z.url().optional(),
  AUTH_CLIENT_ID: z.string().trim().min(1).optional(),
  AUTH_CLIENT_SECRET: z.string().trim().min(1).optional(),
  AUTH_AUDIENCE: z.string().trim().min(1).optional(),
  AUTH_REDIRECT_URI: z.url().optional(),
  WEB_APP_URL: z.url().optional(),
  SESSION_SECRET: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]+$/, "SESSION_SECRET must be base64url")
    .optional(),
});

type EnvironmentShape = z.infer<typeof environmentObject>;
type EnvironmentIssue = Readonly<{ message: string; path: string[] }>;

const environmentIssues = (
  value: EnvironmentShape,
  productionAuthRequired: boolean,
): EnvironmentIssue[] => {
  const issues: EnvironmentIssue[] = [];
  const configured = [
    value.R2_ACCOUNT_ID,
    value.R2_ACCESS_KEY_ID,
    value.R2_SECRET_ACCESS_KEY,
    value.R2_BUCKET,
  ].filter((item) => item !== undefined).length;
  if (configured !== 0 && configured !== 4) {
    issues.push({
      message:
        "R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET must be configured together",
      path: ["R2_ACCOUNT_ID"],
    });
  }
  if (value.JEV_ENABLED && !value.TYPESAFE_API_KEY)
    issues.push({
      message: "TYPESAFE_API_KEY is required when Jev is enabled",
      path: ["TYPESAFE_API_KEY"],
    });
  if (value.JEV_MODE === "active")
    issues.push({ message: "JEV_MODE active requires calibrated routing", path: ["JEV_MODE"] });
  if (value.JEV_BASE_URL !== "https://api.typesafe.ai")
    issues.push({ message: "JEV_BASE_URL must use the TypeSafe API host", path: ["JEV_BASE_URL"] });

  const authFields = [
    value.AUTH_ISSUER_URL,
    value.AUTH_CLIENT_ID,
    value.AUTH_CLIENT_SECRET,
    value.AUTH_AUDIENCE,
    value.AUTH_REDIRECT_URI,
    value.WEB_APP_URL,
    value.SESSION_SECRET,
  ];
  const authConfigured = authFields.filter((item) => item !== undefined).length;
  if (authConfigured !== 0 && authConfigured !== authFields.length) {
    issues.push({
      message:
        "Authentication configuration must be complete: AUTH_ISSUER_URL, AUTH_CLIENT_ID, AUTH_CLIENT_SECRET, AUTH_AUDIENCE, AUTH_REDIRECT_URI, WEB_APP_URL, and SESSION_SECRET",
      path: ["AUTH_ISSUER_URL"],
    });
  }
  if (productionAuthRequired && value.NODE_ENV === "production" && authConfigured === 0) {
    issues.push({
      message: "Production authentication configuration is required",
      path: ["AUTH_ISSUER_URL"],
    });
  }
  if (
    authConfigured === authFields.length &&
    value.SESSION_SECRET !== undefined &&
    Buffer.from(value.SESSION_SECRET, "base64url").length !== 32
  ) {
    issues.push({
      message: "SESSION_SECRET must decode to exactly 32 bytes",
      path: ["SESSION_SECRET"],
    });
  }
  return issues;
};

const environmentSchema = environmentObject.superRefine((value, context) => {
  for (const issue of environmentIssues(value, true))
    context.addIssue({ code: "custom", ...issue });
});

export type AppEnvironment = Readonly<z.infer<typeof environmentSchema>>;

export const parseEnvironment = (input: Record<string, string | undefined>): AppEnvironment =>
  Object.freeze(environmentSchema.parse(input));

const isLoopbackHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/** Loopback or private IPv4 host: where unauthenticated local-AI runtimes may live. */
export const isPrivateRuntimeHost = (host: string): boolean => {
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return true;
  const octets = host.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (octets[0] === 10 ||
      (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
      (octets[0] === 192 && octets[1] === 168))
  );
};

const isPrivateRuntimeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return false;
    return isPrivateRuntimeHost(url.hostname);
  } catch {
    return false;
  }
};

const jobNamePattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

const workerEnvironmentSchema = environmentObject
  .extend({
    WORKER_PROFILE: z.enum(["full", "render_only", "local_ai"]).default("full"),
    // Where this process runs; routes model choices (v2 spec 8, 17.3). Required for local_ai.
    WORKER_MACHINE_KIND: z.enum(["linux_cpu", "desktop_amd", "apple_m1", "cloud_arm"]).optional(),
    // Model files and their models.json manifest live here, outside git (v2 spec 17.5).
    LOCAL_MODELS_DIR: z.string().trim().min(1).optional(),
    SCENE_DIRECTOR_URL: z
      .string()
      .trim()
      .optional()
      .transform((url) => url || undefined),
    SCENE_DIRECTOR_MODEL: z.string().trim().min(1).optional(),
    // VLM key-frame reviewer (v2 slice 29): llama-server with --mmproj, loopback only.
    FRAME_REVIEWER_URL: z
      .string()
      .trim()
      .optional()
      .transform((url) => url || undefined),
    FRAME_REVIEWER_MODEL: z.string().trim().min(1).optional(),
    LOCAL_AI_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    IMAGE_GEN_URL: z
      .string()
      .trim()
      .optional()
      .transform((url) => url || undefined),
    IMAGE_GEN_MODEL: z.string().trim().min(1).default("local:z-image-turbo"),
    IMAGE_EDIT_URL: z
      .string()
      .trim()
      .optional()
      .transform((url) => url || undefined),
    IMAGE_EDIT_MODEL: z.string().trim().min(1).default("local:flux-2-klein-4b"),
    AUTONOMY_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    LOCAL_VIDEO_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    VIDEO_GEN_URL: z
      .string()
      .trim()
      .optional()
      .transform((url) => url || undefined),
    VIDEO_GEN_MODEL: z.string().trim().min(1).default("local:wan2.2-ti2v-5b"),
    LOCAL_AI_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(300_000),
    LOCAL_AI_MAX_IMAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(10_000_000)
      .default(10_000_000),
    LOCAL_AI_MAX_VIDEO_BYTES: z.coerce
      .number()
      .int()
      .min(1_000_000)
      .max(100_000_000)
      .default(50_000_000),
    LOCAL_AI_MAX_VIDEO_FRAMES: z.coerce.number().int().min(1).max(33).default(33),
    LOCAL_AI_MAX_RETRIES: z.coerce.number().int().min(0).max(2).default(1),
    WORKER_JOBS: z
      .string()
      .optional()
      .transform((value) => {
        const names = (value ?? "")
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);
        return names.length > 0 ? names : undefined;
      })
      .pipe(
        z.array(z.string().regex(jobNamePattern, "WORKER_JOBS must list job names")).optional(),
      ),
    // Home machines only (never the A1, spec INV-04): a local image CLI behind SceneGenerator.
    SCENE_GENERATOR_CMD: z.string().trim().min(1).optional(),
    SCENE_GENERATOR_MODEL: z
      .string()
      .regex(/^local:[a-z0-9][a-z0-9.-]*$/, "SCENE_GENERATOR_MODEL must be a local model id")
      .optional(),
  })
  .superRefine((value, context) => {
    // Only a full worker serves HTTP and initialises the auth component (spec 10.5).
    for (const issue of environmentIssues(value, value.WORKER_PROFILE === "full"))
      context.addIssue({ code: "custom", ...issue });
    const problem = (message: string, key: string) =>
      context.addIssue({ code: "custom", message, path: [key] });
    if (value.WORKER_PROFILE === "local_ai") {
      if (value.LOCAL_MODELS_DIR === undefined)
        problem("LOCAL_MODELS_DIR is required for the local_ai profile", "LOCAL_MODELS_DIR");
      if (value.WORKER_MACHINE_KIND === undefined)
        problem("WORKER_MACHINE_KIND is required for the local_ai profile", "WORKER_MACHINE_KIND");
    }
    if (value.LOCAL_MODELS_DIR !== undefined && !isAbsolute(value.LOCAL_MODELS_DIR))
      problem("LOCAL_MODELS_DIR must be an absolute path", "LOCAL_MODELS_DIR");
    if (value.SCENE_DIRECTOR_URL !== undefined && !isLoopbackHttpUrl(value.SCENE_DIRECTOR_URL))
      problem("SCENE_DIRECTOR_URL must be a loopback http(s) URL", "SCENE_DIRECTOR_URL");
    if (value.SCENE_DIRECTOR_MODEL !== undefined && value.SCENE_DIRECTOR_URL === undefined)
      problem("SCENE_DIRECTOR_MODEL needs SCENE_DIRECTOR_URL", "SCENE_DIRECTOR_MODEL");
    if (value.FRAME_REVIEWER_URL !== undefined && !isLoopbackHttpUrl(value.FRAME_REVIEWER_URL))
      problem("FRAME_REVIEWER_URL must be a loopback http(s) URL", "FRAME_REVIEWER_URL");
    if (value.FRAME_REVIEWER_MODEL !== undefined && value.FRAME_REVIEWER_URL === undefined)
      problem("FRAME_REVIEWER_MODEL needs FRAME_REVIEWER_URL", "FRAME_REVIEWER_MODEL");
    for (const key of ["IMAGE_GEN_URL", "IMAGE_EDIT_URL", "VIDEO_GEN_URL"] as const)
      if (value[key] !== undefined && !isPrivateRuntimeUrl(value[key]))
        problem(`${key} must be a private HTTP runtime URL`, key);
    if (value.LOCAL_VIDEO_ENABLED && !value.VIDEO_GEN_URL)
      problem("LOCAL_VIDEO_ENABLED needs VIDEO_GEN_URL", "VIDEO_GEN_URL");
    if ((value.SCENE_GENERATOR_CMD === undefined) !== (value.SCENE_GENERATOR_MODEL === undefined))
      context.addIssue({
        code: "custom",
        message: "SCENE_GENERATOR_CMD and SCENE_GENERATOR_MODEL must be set together",
        path: ["SCENE_GENERATOR_CMD"],
      });
  });

export type WorkerEnvironment = Readonly<z.infer<typeof workerEnvironmentSchema>>;

/** Worker-only parser: the API keeps calling parseEnvironment, whose rules never read WORKER_*. */
export const parseWorkerEnvironment = (
  input: Record<string, string | undefined>,
): WorkerEnvironment => Object.freeze(workerEnvironmentSchema.parse(input));
