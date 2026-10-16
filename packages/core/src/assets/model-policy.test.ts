import { describe, expect, it } from "vitest";
import { mayUseModelCommercially, modelPolicyFor } from "./model-policy.js";

describe("local model policy", () => {
  it("blocks unknown and research-only models in commercial workflows", () => {
    expect(modelPolicyFor("Qwen/Qwen-Image-2.1")).toMatchObject({
      licensePolicy: "research_only",
      enabled: false,
    });
    expect(mayUseModelCommercially("Qwen/Qwen-Image-2.1")).toBe(false);
    expect(mayUseModelCommercially("local:unknown")).toBe(false);
  });

  it("retains the existing local baseline and keeps challengers experimental", () => {
    expect(modelPolicyFor("local:qwen3.5-4b")).toMatchObject({
      capability: "scene_director",
      licensePolicy: "commercial_allowed",
      enabled: true,
    });
    expect(modelPolicyFor("local:qwen3.8-9b-distill")).toMatchObject({
      capability: "scene_director",
      experimental: true,
      enabled: false,
    });
    expect(modelPolicyFor("local:wan2.2-ti2v-5b")).toMatchObject({
      capability: "video_generation",
      enabled: false,
    });
    // 3-step distill of the same 5B model, benched against it before any use.
    expect(modelPolicyFor("local:fastwan2.2-ti2v-5b")).toMatchObject({
      capability: "video_generation",
      license: "Apache-2.0",
      enabled: false,
    });
  });
});

describe("voice bench challengers", () => {
  it("lists MOSS-TTS-Nano disabled and never allows OmniVoice (CC-BY-NC)", async () => {
    const { LOCAL_MODEL_LICENSES } = await import("./model-policy.js");
    expect(modelPolicyFor("local:moss-tts-nano")).toMatchObject({
      capability: "tts",
      license: "Apache-2.0",
      enabled: false,
      experimental: true,
      runtime: "voicestudio",
    });
    expect(modelPolicyFor("local:omnivoice")).toBeUndefined();
    expect(mayUseModelCommercially("local:omnivoice")).toBe(false);
    expect(LOCAL_MODEL_LICENSES["local:omnivoice"]).toBeUndefined();
  });
});

describe("arena challengers", () => {
  it("registers challengers disabled and keeps unread licences out of commercial use", () => {
    expect(modelPolicyFor("local:longcat-image-edit-turbo")).toMatchObject({ enabled: false });
    expect(mayUseModelCommercially("local:longcat-image-edit-turbo")).toBe(true);
    expect(mayUseModelCommercially("local:mage-flow-edit-4b-turbo")).toBe(false);
    expect(modelPolicyFor("local:birefnet")?.capability).toBe("segmentation");
  });
});
