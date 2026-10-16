import { describe, expect, it } from "vitest";
import { modelPolicyFor } from "../assets/model-policy.js";
import { ARENA_CATALOG, ARENA_TASKS, candidatesFor, championFor, profileIdOf } from "./catalog.js";

describe("arena catalog", () => {
  it("only lists registered models whose weights are not research-only", () => {
    for (const candidate of ARENA_CATALOG) {
      const policy = modelPolicyFor(profileIdOf(candidate.id));
      expect(policy, candidate.id).toBeDefined();
      expect(["commercial_allowed", "unknown"], candidate.id).toContain(policy?.licensePolicy);
    }
  });

  it("has unique ids, one champion per task and at least one challenger", () => {
    expect(new Set(ARENA_CATALOG.map((c) => c.id)).size).toBe(ARENA_CATALOG.length);
    for (const task of ARENA_TASKS) {
      expect(
        candidatesFor(task).filter((c) => c.champion),
        task,
      ).toHaveLength(1);
      expect(championFor(task)).toBeDefined();
    }
    expect(
      ARENA_TASKS.filter((task) => candidatesFor(task).length > 1).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("downloads only https files and launches with files it downloads", () => {
    for (const candidate of ARENA_CATALOG) {
      const names = new Set(candidate.files.map((f) => f.file));
      for (const file of candidate.files) expect(file.url).toMatch(/^https:\/\//);
      const launch = candidate.launch;
      const needed =
        launch.runtime === "llama-server"
          ? [launch.model, launch.mmproj]
          : launch.runtime === "sd-server"
            ? [launch.diffusionModel, launch.vae, launch.llm, launch.llmVision, launch.t5xxl]
            : launch.runtime === "audiocpp-server"
              ? [launch.file.split("/").at(-1)]
              : [];
      for (const file of needed.filter(Boolean))
        expect(names.has(file as string), `${candidate.id}: ${file}`).toBe(true);
    }
  });
});
