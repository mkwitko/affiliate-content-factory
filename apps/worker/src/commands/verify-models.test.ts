import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyModels } from "./verify-models.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("verifyModels", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "models-"));
    await mkdir(join(dir, "llm"));
    await writeFile(join(dir, "llm", "director.gguf"), "director-bytes");
    await writeFile(join(dir, "up.onnx"), "upscaler-bytes");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const manifest = (entries: unknown) =>
    writeFile(join(dir, "models.json"), JSON.stringify(entries));
  const director = {
    id: "local:qwen3.5-4b",
    capability: "scene_director",
    file: "llm/director.gguf",
    sha256: sha("director-bytes"),
    licence: "apache-2.0",
  };
  const upscaler = {
    id: "local:realesrgan-ncnn-vulkan",
    capability: "upscale",
    file: "up.onnx",
    sha256: sha("upscaler-bytes"),
    licence: "mit",
  };

  it("verifies a capability only when every one of its files matches its hash", async () => {
    await manifest([director, upscaler]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: ["scene_director", "upscale"],
      failures: [],
    });
    await manifest([director, { ...upscaler, sha256: sha("other") }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: ["scene_director"],
      failures: [{ id: "local:realesrgan-ncnn-vulkan", reason: "sha256_mismatch" }],
    });
  });

  it("refuses a model that is not on the licence allowlist", async () => {
    await manifest([{ ...director, id: "local:unknown-model" }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: "local:unknown-model", reason: "model_not_allowlisted" }],
    });
  });

  it("refuses a manifest that lies about a model's licence or capability", async () => {
    await manifest([{ ...director, licence: "MIT" }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: director.id, reason: "licence_mismatch" }],
    });
    await manifest([{ ...director, capability: "visual_qa" }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: director.id, reason: "capability_mismatch" }],
    });
  });

  it("does not register an experimental challenger as a production capability", async () => {
    await manifest([{ ...director, id: "local:qwen3.8-9b-distill" }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: "local:qwen3.8-9b-distill", reason: "model_disabled" }],
    });
  });

  it("refuses the M1 image model on desktop_amd only", async () => {
    await writeFile(join(dir, "bonsai.gguf"), "bonsai-bytes");
    const bonsai = {
      id: "local:bonsai-image-4b",
      capability: "image_generation",
      file: "bonsai.gguf",
      sha256: sha("bonsai-bytes"),
      licence: "apache-2.0",
    };
    await manifest([bonsai]);
    expect(await verifyModels(dir, "desktop_amd")).toMatchObject({
      verified: [],
      failures: [{ id: "local:bonsai-image-4b", reason: "model_refused_on_machine" }],
    });
    expect(await verifyModels(dir, "apple_m1")).toMatchObject({
      verified: ["image_generation"],
      failures: [],
    });
  });

  it("reports missing files, bad entries, escaping paths and a missing manifest", async () => {
    await manifest([{ ...director, file: "llm/gone.gguf" }]);
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: "local:qwen3.5-4b", reason: "file_missing" }],
    });
    await manifest([{ ...director, file: "../etc/passwd" }]);
    expect(await verifyModels(dir)).toMatchObject({
      failures: [{ id: "local:qwen3.5-4b", reason: "path_outside_models_dir" }],
    });
    await manifest([
      { ...director, licence: "" },
      { id: "x" },
      { ...director, id: "c", capability: "teleport" },
    ]);
    expect((await verifyModels(dir)).failures.map((failure) => failure.reason)).toEqual([
      "entry_invalid",
      "entry_invalid",
      "entry_invalid",
    ]);
    await rm(join(dir, "models.json"));
    expect(await verifyModels(dir)).toMatchObject({
      verified: [],
      failures: [{ id: "models.json", reason: "manifest_unreadable" }],
    });
  });
});
