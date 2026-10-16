import { join } from "node:path";
import type { ArenaCandidate } from "@money-maker/core/arena/catalog";
import {
  type ArenaEnv,
  ensureLinuxBinary,
  type RunningServer,
  startDesktopServer,
  startLocalServer,
} from "./runtime.js";

/**
 * Starts the server a catalog entry needs: llama-server locally (CPU) or on the desktop (Vulkan,
 * all layers on the GPU); sd-server on the desktop only. File names resolve under the models dir
 * as the runtime sees it, including bare file names inside extra args (e.g. "--tae x.safetensors").
 */
const LLAMA_PORT = 18081;

const modelPath = (env: ArenaEnv, file: string) =>
  env.target === "desktop_amd"
    ? `${env.runtimeModelsDir}\\${file}`
    : join(env.runtimeModelsDir, file);

export const startLlama = async (
  env: ArenaEnv,
  candidate: ArenaCandidate,
): Promise<RunningServer> => {
  const launch = candidate.launch;
  if (launch.runtime !== "llama-server") throw new Error("arena_launch_mismatch");
  const args = [
    "-m",
    modelPath(env, launch.model),
    ...(launch.mmproj ? ["--mmproj", modelPath(env, launch.mmproj)] : []),
    "-c",
    String(launch.contextSize),
    "--temp",
    "0",
    "--jinja",
  ];
  if (env.target === "desktop_amd")
    return startDesktopServer(env, "llama", [...args, "-ngl", "99"]);
  const binary = await ensureLinuxBinary(env, "llama");
  return startLocalServer(
    binary,
    [
      ...args,
      "--host",
      "127.0.0.1",
      "--port",
      String(LLAMA_PORT),
      "-t",
      process.env.ARENA_THREADS ?? "8",
    ],
    `http://127.0.0.1:${LLAMA_PORT}`,
    "/health",
  );
};

export const startSd = async (env: ArenaEnv, candidate: ArenaCandidate): Promise<RunningServer> => {
  const launch = candidate.launch;
  if (launch.runtime !== "sd-server") throw new Error("arena_launch_mismatch");
  if (env.target !== "desktop_amd") throw new Error("sd_server_needs_desktop");
  const files = new Set(candidate.files.map((f) => f.file));
  const args = [
    "--diffusion-model",
    modelPath(env, launch.diffusionModel),
    ...(launch.vae ? ["--vae", modelPath(env, launch.vae)] : []),
    ...(launch.llm ? ["--llm", modelPath(env, launch.llm)] : []),
    ...(launch.llmVision ? ["--llm_vision", modelPath(env, launch.llmVision)] : []),
    ...(launch.t5xxl ? ["--t5xxl", modelPath(env, launch.t5xxl)] : []),
    ...launch.args.map((arg) => (files.has(arg) ? modelPath(env, arg) : arg)),
  ];
  return startDesktopServer(env, "sd", args);
};
