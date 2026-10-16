// apps/worker/src/commands/verify-models.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isAllowedLocalModel, modelRefusedOnMachine } from "@money-maker/core/assets/asset";
import { modelPolicyFor } from "@money-maker/core/assets/model-policy";
import { LOCAL_AI_CAPABILITIES, type LocalAiCapability } from "../worker-profile.js";

/**
 * models.json under LOCAL_MODELS_DIR: an array of { id, capability, file, sha256, licence }.
 * `file` is relative to the models dir. A capability is verified only when it has at least one
 * entry and every entry's file exists and matches its sha256 (v2 spec 17.5).
 */
export type ModelFailure = Readonly<{ id: string; reason: string }>;
export type ModelVerification = Readonly<{
  verified: readonly LocalAiCapability[];
  failures: readonly ModelFailure[];
}>;

const CAPABILITIES: readonly string[] = Object.values(LOCAL_AI_CAPABILITIES);
const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const sha256Of = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolveHash(hash.digest("hex")));
  });

export const verifyModels = async (
  modelsDir: string,
  machineKind?: string,
): Promise<ModelVerification> => {
  const root = resolve(modelsDir);
  let entries: unknown;
  try {
    entries = JSON.parse(await readFile(resolve(root, "models.json"), "utf8"));
  } catch {
    return { verified: [], failures: [{ id: "models.json", reason: "manifest_unreadable" }] };
  }
  if (!Array.isArray(entries))
    return { verified: [], failures: [{ id: "models.json", reason: "manifest_unreadable" }] };

  const failures: ModelFailure[] = [];
  const seen = new Set<string>();
  const broken = new Set<string>();
  for (const entry of entries as unknown[]) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = text(item.id) ? item.id : "unknown";
    const fail = (capability: unknown, reason: string) => {
      failures.push({ id, reason });
      if (typeof capability === "string") broken.add(capability);
    };
    if (
      !text(item.id) ||
      !text(item.capability) ||
      !CAPABILITIES.includes(item.capability) ||
      !text(item.file) ||
      !text(item.licence) ||
      !text(item.sha256) ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    ) {
      fail(item.capability, "entry_invalid");
      continue;
    }
    if (!isAllowedLocalModel(item.id)) {
      fail(item.capability, "model_not_allowlisted");
      continue;
    }
    const policy = modelPolicyFor(item.id);
    if (
      !policy ||
      (policy.capability !== item.capability &&
        !(policy.capability === "image_editing" && item.capability === "image_generation"))
    ) {
      fail(item.capability, "capability_mismatch");
      continue;
    }
    if (policy.license.toLowerCase() !== item.licence.toLowerCase()) {
      fail(item.capability, "licence_mismatch");
      continue;
    }
    if (!policy.enabled) {
      fail(item.capability, "model_disabled");
      continue;
    }
    if (modelRefusedOnMachine(item.id, machineKind)) {
      fail(item.capability, "model_refused_on_machine");
      continue;
    }
    seen.add(item.capability);
    const path = resolve(root, item.file);
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) {
      fail(item.capability, "path_outside_models_dir");
      continue;
    }
    // ponytail: hashes the whole file at every boot (seconds per GB); cache by mtime if it hurts.
    const actual = await sha256Of(path).catch(() => null);
    if (actual === null) fail(item.capability, "file_missing");
    else if (actual !== item.sha256) fail(item.capability, "sha256_mismatch");
  }
  return {
    verified: (CAPABILITIES as LocalAiCapability[]).filter(
      (capability) => seen.has(capability) && !broken.has(capability),
    ),
    failures,
  };
};

const isMainModule =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  const dir = process.env.LOCAL_MODELS_DIR;
  if (!dir || !isAbsolute(dir)) {
    console.error("Set LOCAL_MODELS_DIR to an absolute path.");
    process.exitCode = 1;
  } else {
    void verifyModels(dir, process.env.WORKER_MACHINE_KIND).then((result) => {
      console.info(JSON.stringify(result, null, 2));
      if (result.failures.length > 0) process.exitCode = 1;
    });
  }
}
