import { describe, expect, it } from "vitest";
import { parseEnvironment, parseWorkerEnvironment } from "./environment.js";

type EnvironmentModule = {
  parseEnvironment?: (input: Record<string, string | undefined>) => unknown;
};

const loadParser = async () => {
  const environmentModule = (await import("./environment.js").catch(
    () => ({}) as EnvironmentModule,
  )) as EnvironmentModule;

  expect(environmentModule.parseEnvironment).toBeTypeOf("function");
  return environmentModule.parseEnvironment;
};

describe("parseEnvironment", () => {
  const database = "postgresql://postgres:postgres@localhost:5432/money_maker";
  const authentication = {
    AUTH_ISSUER_URL: "https://issuer.example",
    AUTH_CLIENT_ID: "money-maker",
    AUTH_CLIENT_SECRET: "client-secret-placeholder",
    AUTH_AUDIENCE: "money-maker-api",
    AUTH_REDIRECT_URI: "https://api.example/v1/auth/callback",
    WEB_APP_URL: "https://web.example",
    SESSION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };

  it("parses only declared configuration", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    const result = parseEnvironment({
      DATABASE_URL: database,
      NODE_ENV: "test",
      PORT: "4000",
      UNEXPECTED_SECRET: "must-not-escape",
    });

    expect(result).toEqual({
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/money_maker",
      NODE_ENV: "test",
      PORT: 4000,
      JEV_ENABLED: false,
      JEV_MODE: "shadow",
      GENERATION_POLICY: "cloud_allowed",
      JEV_BASE_URL: "https://api.typesafe.ai",
      JEV_MODEL: "jev-latest",
    });
    expect(result).not.toHaveProperty("UNEXPECTED_SECRET");
  });

  it("accepts an optional YouTube public metadata API key", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;
    expect(
      parseEnvironment({
        DATABASE_URL: database,
        NODE_ENV: "test",
        YOUTUBE_DATA_API_KEY: "public-metadata-key",
      }),
    ).toMatchObject({ YOUTUBE_DATA_API_KEY: "public-metadata-key" });
  });

  it("keeps Jev off by default and requires a key when enabled", () => {
    expect(parseEnvironment({ DATABASE_URL: database }).JEV_ENABLED).toBe(false);
    expect(() => parseEnvironment({ DATABASE_URL: database, JEV_ENABLED: "true" })).toThrow(
      /TYPESAFE_API_KEY/,
    );
    expect(() =>
      parseEnvironment({
        DATABASE_URL: database,
        JEV_ENABLED: "true",
        JEV_MODE: "active",
        TYPESAFE_API_KEY: "placeholder",
      }),
    ).toThrow(/JEV_MODE/);
    expect(
      parseEnvironment({
        DATABASE_URL: database,
        JEV_ENABLED: "true",
        TYPESAFE_API_KEY: "placeholder",
      }),
    ).toMatchObject({ JEV_ENABLED: true, JEV_MODE: "shadow" });
  });

  it("identifies a missing database URL", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() => parseEnvironment({ NODE_ENV: "test" })).toThrow(/DATABASE_URL/);
  });

  it("rejects a malformed database URL", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() => parseEnvironment({ DATABASE_URL: "not-a-url", NODE_ENV: "test" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects partial R2 configuration", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() =>
      parseEnvironment({
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/money_maker",
        R2_ACCOUNT_ID: "account-1",
      }),
    ).toThrow(/R2_ACCOUNT_ID/);
  });

  it("accepts a complete authentication configuration", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(parseEnvironment({ DATABASE_URL: database, ...authentication })).toMatchObject(
      authentication,
    );
  });

  it("accepts an explicit API bind host", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(
      parseEnvironment({
        DATABASE_URL: database,
        HOST: "0.0.0.0",
      }),
    ).toMatchObject({ HOST: "0.0.0.0" });
  });

  it("rejects a partial authentication configuration", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() =>
      parseEnvironment({ DATABASE_URL: database, AUTH_ISSUER_URL: authentication.AUTH_ISSUER_URL }),
    ).toThrow(/AUTH_ISSUER_URL/);
  });

  it("requires authentication configuration in production", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() => parseEnvironment({ DATABASE_URL: database, NODE_ENV: "production" })).toThrow(
      /authentication/i,
    );
  });

  it("requires a 32-byte base64url session secret", async () => {
    const parseEnvironment = await loadParser();
    if (!parseEnvironment) return;

    expect(() =>
      parseEnvironment({
        DATABASE_URL: database,
        ...authentication,
        SESSION_SECRET: "too-short",
      }),
    ).toThrow(/SESSION_SECRET/);
  });
});

describe("parseWorkerEnvironment", () => {
  const database = "postgresql://postgres:postgres@localhost:5432/money_maker";

  it("accepts a local scene generator command only together with a local model id", () => {
    const local = {
      DATABASE_URL: database,
      SCENE_GENERATOR_CMD: "/opt/money-maker/scripts/local-ai/scene_generator.py",
      SCENE_GENERATOR_MODEL: "local:z-image-turbo",
    };
    expect(parseWorkerEnvironment(local)).toMatchObject({
      SCENE_GENERATOR_CMD: local.SCENE_GENERATOR_CMD,
      SCENE_GENERATOR_MODEL: "local:z-image-turbo",
    });
    expect(() =>
      parseWorkerEnvironment({
        DATABASE_URL: database,
        SCENE_GENERATOR_CMD: local.SCENE_GENERATOR_CMD,
      }),
    ).toThrow(/together/);
    expect(() => parseWorkerEnvironment({ ...local, SCENE_GENERATOR_MODEL: "flux dev" })).toThrow();
    // The API parser never reads worker-only settings.
    expect(parseEnvironment(local)).not.toHaveProperty("SCENE_GENERATOR_CMD");
  });

  it("defaults to the full profile, every job, and the API's production auth rule", () => {
    const parsed = parseWorkerEnvironment({ DATABASE_URL: database });
    expect(parsed.WORKER_PROFILE).toBe("full");
    expect(parsed.WORKER_JOBS).toBeUndefined();
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, NODE_ENV: "production" }),
    ).toThrow(/authentication/i);
  });

  it("accepts a local_ai worker with a models dir and machine kind, and no AUTH_* in production", () => {
    const local = {
      DATABASE_URL: database,
      NODE_ENV: "production",
      WORKER_PROFILE: "local_ai",
      LOCAL_MODELS_DIR: "/home/me/models",
      WORKER_MACHINE_KIND: "desktop_amd",
      SCENE_DIRECTOR_URL: "http://127.0.0.1:8081",
      SCENE_DIRECTOR_MODEL: "qwen",
    };
    expect(parseWorkerEnvironment(local)).toMatchObject({
      WORKER_PROFILE: "local_ai",
      WORKER_MACHINE_KIND: "desktop_amd",
    });
    expect(() => parseWorkerEnvironment({ ...local, LOCAL_MODELS_DIR: undefined })).toThrow(
      /LOCAL_MODELS_DIR/,
    );
    expect(() => parseWorkerEnvironment({ ...local, WORKER_MACHINE_KIND: undefined })).toThrow(
      /WORKER_MACHINE_KIND/,
    );
    expect(() => parseWorkerEnvironment({ ...local, WORKER_MACHINE_KIND: "toaster" })).toThrow();
    expect(() => parseWorkerEnvironment({ ...local, LOCAL_MODELS_DIR: "models" })).toThrow(
      /absolute/,
    );
  });

  it("keeps the frame reviewer on loopback and its model tied to a URL", () => {
    expect(() =>
      parseWorkerEnvironment({
        DATABASE_URL: database,
        FRAME_REVIEWER_URL: "http://10.0.0.5:8081",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, FRAME_REVIEWER_MODEL: "qwen3-vl" }),
    ).toThrow(/FRAME_REVIEWER_URL/);
    expect(
      parseWorkerEnvironment({ DATABASE_URL: database, FRAME_REVIEWER_URL: " " })
        .FRAME_REVIEWER_URL,
    ).toBeUndefined();
  });

  it("keeps the scene director on loopback and its model tied to a URL", () => {
    expect(() =>
      parseWorkerEnvironment({
        DATABASE_URL: database,
        SCENE_DIRECTOR_URL: "http://10.0.0.5:8081",
      }),
    ).toThrow(/loopback/);
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, SCENE_DIRECTOR_MODEL: "qwen" }),
    ).toThrow(/SCENE_DIRECTOR_URL/);
    expect(
      parseWorkerEnvironment({ DATABASE_URL: database, SCENE_DIRECTOR_URL: "  " })
        .SCENE_DIRECTOR_URL,
    ).toBeUndefined();
  });

  it("parses the generation policy and rejects unknown values", () => {
    expect(parseWorkerEnvironment({ DATABASE_URL: database }).GENERATION_POLICY).toBe(
      "cloud_allowed",
    );
    expect(
      parseEnvironment({ DATABASE_URL: database, GENERATION_POLICY: "local_only" })
        .GENERATION_POLICY,
    ).toBe("local_only");
    expect(() => parseEnvironment({ DATABASE_URL: database, GENERATION_POLICY: "cloud" })).toThrow(
      /generation_policy_invalid/,
    );
  });

  it("bounds optional native local media settings and keeps video off", () => {
    const base = parseWorkerEnvironment({ DATABASE_URL: database });
    expect(base.LOCAL_AI_ENABLED).toBe(false);
    expect(base.LOCAL_VIDEO_ENABLED).toBe(false);
    expect(base.AUTONOMY_ENABLED).toBe(false);
    expect(
      parseWorkerEnvironment({ DATABASE_URL: database, AUTONOMY_ENABLED: "true" }).AUTONOMY_ENABLED,
    ).toBe(true);
    expect(base.LOCAL_AI_MAX_VIDEO_FRAMES).toBe(33);
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, LOCAL_AI_MAX_VIDEO_FRAMES: "1000" }),
    ).toThrow(/LOCAL_AI_MAX_VIDEO_FRAMES/);
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, LOCAL_AI_MAX_RETRIES: "99" }),
    ).toThrow(/LOCAL_AI_MAX_RETRIES/);
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, IMAGE_GEN_URL: "http://example.com:8080" }),
    ).toThrow(/IMAGE_GEN_URL/);
    expect(
      parseWorkerEnvironment({ DATABASE_URL: database, IMAGE_GEN_URL: "http://172.26.0.1:8080" })
        .IMAGE_GEN_URL,
    ).toBe("http://172.26.0.1:8080");
  });

  it("starts a render_only worker in production without AUTH_*", () => {
    expect(
      parseWorkerEnvironment({
        DATABASE_URL: database,
        NODE_ENV: "production",
        WORKER_PROFILE: "render_only",
      }),
    ).toMatchObject({ WORKER_PROFILE: "render_only", NODE_ENV: "production" });
  });

  it("still rejects a partial AUTH_* set on a render_only worker", () => {
    expect(() =>
      parseWorkerEnvironment({
        DATABASE_URL: database,
        WORKER_PROFILE: "render_only",
        AUTH_ISSUER_URL: "https://issuer.example",
      }),
    ).toThrow(/AUTH_ISSUER_URL/);
  });

  it("parses WORKER_JOBS as a trimmed list and treats an empty value as unset", () => {
    expect(
      parseWorkerEnvironment({
        DATABASE_URL: database,
        WORKER_JOBS: " render_reel , render_long_form ",
      }).WORKER_JOBS,
    ).toEqual(["render_reel", "render_long_form"]);
    expect(
      parseWorkerEnvironment({ DATABASE_URL: database, WORKER_JOBS: " " }).WORKER_JOBS,
    ).toBeUndefined();
  });

  it("rejects an unknown profile and a malformed job name", () => {
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, WORKER_PROFILE: "gpu" }),
    ).toThrow();
    expect(() =>
      parseWorkerEnvironment({ DATABASE_URL: database, WORKER_JOBS: "render reel" }),
    ).toThrow(/WORKER_JOBS/);
  });

  it("never lets WORKER_PROFILE relax the API's production auth rule", () => {
    expect(() =>
      parseEnvironment({
        DATABASE_URL: database,
        NODE_ENV: "production",
        WORKER_PROFILE: "render_only",
      }),
    ).toThrow(/authentication/i);
  });
});
