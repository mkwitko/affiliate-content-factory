import { describe, expect, it } from "vitest";
import { agnesApiKeyFor, sceneGeneratorFor } from "./scene-generator.js";

describe("sceneGeneratorFor", () => {
  const cloudflare = {
    CLOUDFLARE_ACCOUNT_ID: "account",
    CLOUDFLARE_API_TOKEN: "token",
    CLOUDFLARE_AI_GATEWAY: "money-maker",
  };
  it("prefers the local command, falls back to Workers AI, and is null without either", () => {
    expect(sceneGeneratorFor({})).toBeNull();
    expect(sceneGeneratorFor(cloudflare)).not.toBeNull();
    // An unknown local model throws, which proves the command path wins over Workers AI.
    expect(() =>
      sceneGeneratorFor({
        ...cloudflare,
        SCENE_GENERATOR_CMD: "/opt/scene_generator.py",
        SCENE_GENERATOR_MODEL: "local:unknown",
      }),
    ).toThrow("scene_generator_model_unknown");
    expect(
      sceneGeneratorFor({
        SCENE_GENERATOR_CMD: "/opt/scene_generator.py",
        SCENE_GENERATOR_MODEL: "local:z-image-turbo",
      }),
    ).not.toBeNull();
  });

  it("never selects Workers AI under local_only, but keeps the local command", () => {
    expect(sceneGeneratorFor({ ...cloudflare, GENERATION_POLICY: "local_only" })).toBeNull();
    expect(sceneGeneratorFor({ ...cloudflare, GENERATION_POLICY: "local_first" })).not.toBeNull();
    expect(
      sceneGeneratorFor({
        ...cloudflare,
        GENERATION_POLICY: "local_only",
        SCENE_GENERATOR_CMD: "/opt/scene_generator.py",
        SCENE_GENERATOR_MODEL: "local:z-image-turbo",
      }),
    ).not.toBeNull();
  });

  it("withholds the hosted Agnes key under local_only only", () => {
    const env = { AGNES_API_KEY: "key" };
    expect(agnesApiKeyFor(env)).toBe("key");
    expect(agnesApiKeyFor({ ...env, GENERATION_POLICY: "local_first" })).toBe("key");
    expect(agnesApiKeyFor({ ...env, GENERATION_POLICY: "local_only" })).toBeUndefined();
    expect(() => agnesApiKeyFor({ ...env, GENERATION_POLICY: "nope" })).toThrow(
      "generation_policy_invalid",
    );
  });

  it("refuses the M1 image model on the AMD desktop and allows it on the M1", () => {
    const local = {
      SCENE_GENERATOR_CMD: "/opt/scene_generator.py",
      SCENE_GENERATOR_MODEL: "local:bonsai-image-4b",
    };
    expect(() => sceneGeneratorFor({ ...local, WORKER_MACHINE_KIND: "desktop_amd" })).toThrow(
      "scene_generator_model_refused_on_machine",
    );
    expect(sceneGeneratorFor({ ...local, WORKER_MACHINE_KIND: "apple_m1" })).not.toBeNull();
  });
});
