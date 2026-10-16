import { describe, expect, it } from "vitest";
import { CAPABILITY_IDS, evaluateCapabilities } from "./capability-health.js";

const find = (rows: ReturnType<typeof evaluateCapabilities>, id: string) =>
  rows.find((row) => row.capability === id)!;

describe("evaluateCapabilities", () => {
  it("covers every capability and falls back to scene bank reuse when nothing is probed", () => {
    const rows = evaluateCapabilities({}, "cloud_allowed");
    expect(rows.map((row) => row.capability)).toEqual([...CAPABILITY_IDS]);
    const image = find(rows, "image_generation");
    expect(image.active).toBe("scene_bank_reuse");
    expect(image.backends[0]).toMatchObject({ id: "home_worker:sd.cpp", state: "unconfigured" });
    expect(find(rows, "tts").active).toBeNull();
  });

  it("picks the first healthy backend in routing order; experimental never becomes active", () => {
    const rows = evaluateCapabilities(
      {
        "home_worker:sd.cpp": { state: "ok", reason: "pending_review" },
        "local:command_generator": { state: "ok", reason: "healthy" },
      },
      "local_only",
    );
    const image = find(rows, "image_generation");
    expect(image.backends[0]?.state).toBe("experimental");
    expect(image.active).toBe("local:command_generator");
  });

  it("blocks hosted backends under local_only and not under cloud_allowed", () => {
    const seen = {
      "workers_ai:flux-1-schnell": { state: "ok" as const },
      agnes_hosted: { state: "ok" as const },
    };
    const blocked = evaluateCapabilities(seen, "local_only");
    expect(find(blocked, "image_generation").backends[2]?.state).toBe("policy_blocked");
    expect(find(blocked, "video_generation").backends[1]?.state).toBe("policy_blocked");
    expect(find(evaluateCapabilities(seen, "cloud_allowed"), "image_generation").active).toBe(
      "workers_ai:flux-1-schnell",
    );
  });

  it("reports disabled and offline as observed and image_editing through the home worker", () => {
    const rows = evaluateCapabilities(
      {
        "local:wan2.2-ti2v-5b": { state: "disabled", reason: "LOCAL_VIDEO_ENABLED off" },
        "local:kokoro": { state: "offline", reason: "no answer" },
      },
      "cloud_allowed",
    );
    expect(find(rows, "video_generation").backends[0]).toMatchObject({ state: "disabled" });
    expect(find(rows, "tts").backends[0]).toMatchObject({ state: "offline", reason: "no answer" });
    expect(find(rows, "image_editing").backends[0]).toMatchObject({
      id: "home_worker:image_editing",
      state: "unconfigured",
    });
    expect(find(rows, "image_editing").active).toBeNull();
    const served = evaluateCapabilities(
      { "home_worker:image_editing": { state: "ok" } },
      "local_only",
    );
    expect(find(served, "image_editing").active).toBe("home_worker:image_editing");
  });
});
