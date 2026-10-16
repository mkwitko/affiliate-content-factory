import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_GENERATOR_LICENSES, modelRefusedOnMachine } from "@money-maker/core/assets/asset";
import type { SceneGenerator } from "@money-maker/core/creatives/scene-bank";
import { fitImage } from "../http/fit-image.js";
import { runProcess } from "./run-process.js";

/**
 * A local image CLI (stable-diffusion.cpp, mflux, Bonsai Image) behind the SceneGenerator port.
 * Home machines only: the cloud VM never sets SCENE_GENERATOR_CMD (spec INV-04).
 * Protocol: `<command> --prompt <text> --width <w> --height <h> --seed <n> --out <file.png>`,
 * plus `--reference <file.png>` when a style reference image is given (v2 slice 27).
 * `machineKind` (WORKER_MACHINE_KIND) refuses a model that must not run there.
 */
export const createCommandSceneGenerator = (
  options: Readonly<{
    command: string;
    model: string;
    timeoutMs?: number;
    tmpRoot?: string;
    machineKind?: string | undefined;
  }>,
): SceneGenerator => {
  const weights = LOCAL_GENERATOR_LICENSES[options.model];
  if (!weights) throw new Error("scene_generator_model_unknown");
  if (modelRefusedOnMachine(options.model, options.machineKind))
    throw new Error("scene_generator_model_refused_on_machine");
  return {
    async generate(prompt, size, generateOptions) {
      const width = size?.width ?? 1024;
      const height = size?.height ?? 1024;
      // The same prompt always gets the same seed, so a banked image can be regenerated.
      const seed = createHash("sha256").update(prompt).digest().readUInt32BE(0) % 2_147_483_647;
      const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "scene-generator-"));
      try {
        const out = join(dir, "out.png");
        const reference = join(dir, "reference.png");
        if (generateOptions?.reference) await writeFile(reference, generateOptions.reference);
        try {
          await runProcess(
            options.command,
            [
              "--prompt",
              prompt,
              "--width",
              String(width),
              "--height",
              String(height),
              "--seed",
              String(seed),
              "--out",
              out,
              ...(generateOptions?.reference ? ["--reference", reference] : []),
            ],
            { timeoutMs: options.timeoutMs ?? 180_000 },
          );
        } catch (error) {
          throw new Error(
            error instanceof Error && error.message === "process_timeout"
              ? "scene_provider_timeout"
              : "scene_provider_error:command",
          );
        }
        const bytes = await readFile(out).then(
          (buffer) => new Uint8Array(buffer),
          () => null,
        );
        const image = bytes ? await fitImage(bytes).catch(() => null) : null;
        if (!bytes || !image || (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg"))
          throw new Error("scene_provider_response_invalid");
        return {
          bytes,
          mimeType: image.mimeType,
          width: image.width,
          height: image.height,
          neurons: 0,
          model: options.model,
          license: `${weights} (${options.model}, local)`,
          seed,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};
