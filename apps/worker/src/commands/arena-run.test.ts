import { describe, expect, it } from "vitest";
import { classifyFailure, licenceRefusal, planCandidates } from "./arena-run.js";

describe("arena run planning", () => {
  it("runs the champion first and leaves optional candidates out unless named", () => {
    const plan = planCandidates("image.character_product", "desktop_amd", null).map((c) => c.id);
    expect(plan[0]).toBe("local:flux-2-klein-4b");
    expect(plan).not.toContain("local:qwen-image-edit-2511");
    expect(
      planCandidates("image.character_product", "desktop_amd", ["local:qwen-image-edit-2511"]).map(
        (c) => c.id,
      ),
    ).toEqual(["local:qwen-image-edit-2511"]);
  });

  it("keeps GPU-only candidates off the cpu target", () => {
    expect(planCandidates("image.scene_plate", "cpu", null)).toEqual([]);
    expect(planCandidates("tts.ptbr", "cpu", null).length).toBeGreaterThan(5);
  });

  it("lets registered challengers through the licence gate", () => {
    const [first] = planCandidates("tts.ptbr", "cpu", null);
    expect(first && licenceRefusal(first)).toBeNull();
  });

  it("never turns missing inputs into a model verdict", () => {
    expect(classifyFailure("download_failed_404", "")).toBe("NOT_TESTED");
    expect(classifyFailure("fetch failed", "ConnectTimeoutError")).toBe("NOT_TESTED");
    expect(classifyFailure("ENOENT: no such file, open 'edit-bench-out/images/x.png'", "")).toBe(
      "NOT_TESTED",
    );
    expect(classifyFailure("runtime_start_failed", "ggml_vulkan: ErrorOutOfDeviceMemory")).toBe(
      "OOM",
    );
    expect(classifyFailure("runtime_start_failed", "unknown architecture")).toBe("RUNTIME_BLOCKED");
    expect(classifyFailure("audiocpp_speech_http_500", "")).toBe("FAILED");
  });
});
