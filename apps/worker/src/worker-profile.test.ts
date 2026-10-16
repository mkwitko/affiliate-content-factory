// apps/worker/src/worker-profile.test.ts

import type { JobHandler } from "@money-maker/core/jobs/job";
import { describe, expect, it, vi } from "vitest";
import {
  assertLeaseFitsReelReset,
  assertLocalAiDatabase,
  detectCapabilities,
  selectHandlers,
} from "./worker-profile.js";

const handler: JobHandler = async () => undefined;
const every = {
  publish_content: handler,
  reconcile_publication: handler,
  render_creatives: handler,
  render_reel: handler,
  render_long_form: handler,
  render_owned_clip: handler,
  generate_scene_clips: handler,
};
const capable = { ffmpeg: true, tts: true, scene_clips: true };

describe("selectHandlers", () => {
  it("keeps every registered handler on the full profile", () => {
    expect(
      Object.keys(
        selectHandlers({ handlers: every, profile: "full", capabilities: capable }),
      ).sort(),
    ).toEqual(Object.keys(every).sort());
  });

  it("drops publishing on render_only and drops what a missing capability cannot run", () => {
    expect(
      Object.keys(
        selectHandlers({
          handlers: every,
          profile: "render_only",
          capabilities: { ffmpeg: true, tts: false, scene_clips: false },
        }),
      ).sort(),
    ).toEqual(["render_creatives", "render_owned_clip", "render_reel"]);
  });

  it("narrows to WORKER_JOBS", () => {
    expect(
      Object.keys(
        selectHandlers({
          handlers: every,
          profile: "render_only",
          jobs: ["render_long_form"],
          capabilities: capable,
        }),
      ),
    ).toEqual(["render_long_form"]);
  });

  it("refuses a job the profile forbids, a typo, and an unavailable requested job", () => {
    const select =
      (jobs: string[], capabilities = capable) =>
      () =>
        selectHandlers({ handlers: every, profile: "render_only", jobs, capabilities });
    expect(select(["publish_content"])).toThrow("worker_jobs_invalid:publish_content");
    expect(select(["render_reels"])).toThrow("worker_jobs_invalid:render_reels");
    expect(select(["render_long_form"], { ffmpeg: true, tts: false, scene_clips: true })).toThrow(
      "worker_job_unavailable:render_long_form",
    );
  });

  it("refuses to boot with nothing to claim", () => {
    expect(() =>
      selectHandlers({
        handlers: { render_reel: handler },
        profile: "render_only",
        capabilities: { ffmpeg: false, tts: false, scene_clips: false },
      }),
    ).toThrow("worker_no_jobs");
  });
});

describe("generate_scene_clips registration", () => {
  it("is claimed on both profiles only when the scene_clips capability exists", () => {
    for (const profile of ["full", "render_only"] as const) {
      expect(
        Object.keys(selectHandlers({ handlers: every, profile, capabilities: capable })),
      ).toContain("generate_scene_clips");
      expect(
        Object.keys(
          selectHandlers({
            handlers: every,
            profile,
            capabilities: { ffmpeg: true, tts: true, scene_clips: false },
          }),
        ),
      ).not.toContain("generate_scene_clips");
    }
  });
  it("fails the boot when WORKER_JOBS asks for it without a key", () => {
    expect(() =>
      selectHandlers({
        handlers: every,
        profile: "render_only",
        jobs: ["generate_scene_clips"],
        capabilities: { ffmpeg: true, tts: true, scene_clips: false },
      }),
    ).toThrow("worker_job_unavailable:generate_scene_clips");
  });
});

describe("detectCapabilities scene_clips", () => {
  const base = { probeBinary: async () => undefined };
  it("is off without a key and never calls the provider", async () => {
    const fetch = vi.fn();
    const result = await detectCapabilities({
      ...base,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.scene_clips).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("is on when /v1/models answers 200 to the key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await detectCapabilities({
      ...base,
      agnesApiKey: "sk-secret",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    expect(result.scene_clips).toBe(true);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("https://apihub.agnes-ai.com/v1/models");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer sk-secret" });
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });
  it("is off on a rejected key or an unreachable provider", async () => {
    for (const fetch of [
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    ])
      expect(
        (
          await detectCapabilities({
            ...base,
            agnesApiKey: "sk-secret",
            fetch: fetch as unknown as typeof globalThis.fetch,
          })
        ).scene_clips,
      ).toBe(false);
  });
});

describe("detectCapabilities", () => {
  it("reports ffmpeg only when both ffmpeg and ffprobe run", async () => {
    const probeBinary = vi.fn(async (name: string) => {
      if (name === "ffprobe") throw new Error("ENOENT");
    });
    await expect(detectCapabilities({ probeBinary })).resolves.toEqual({
      ffmpeg: false,
      tts: false,
      scene_clips: false,
    });
  });

  it("waits a bounded time for a cold TTS instead of dropping it", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue(new Response("[]", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    await expect(
      detectCapabilities({
        ttsUrl: "http://tts:8880",
        probeBinary: async () => undefined,
        fetch: fetch as unknown as typeof globalThis.fetch,
        sleep,
      }),
    ).resolves.toEqual({ ffmpeg: true, tts: true, scene_clips: false });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://tts:8880/v1/audio/voices");
  });

  it("gives up on TTS after the wait window", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 503 }));
    await expect(
      detectCapabilities({
        ttsUrl: "http://tts:8880",
        probeBinary: async () => undefined,
        fetch: fetch as unknown as typeof globalThis.fetch,
        sleep: async () => undefined,
        ttsWaitMs: 6_000,
      }),
    ).resolves.toEqual({ ffmpeg: true, tts: false, scene_clips: false });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("refuses a lease longer than the stale reel reset when this worker renders reels", () => {
    expect(() =>
      assertLeaseFitsReelReset({ jobs: ["render_reel"], leaseDurationMs: 900_000 }),
    ).not.toThrow();
    expect(() =>
      assertLeaseFitsReelReset({ jobs: ["render_reel"], leaseDurationMs: 900_001 }),
    ).toThrow("worker_lease_exceeds_reel_reset:900001");
    expect(() =>
      assertLeaseFitsReelReset({ jobs: ["render_long_form"], leaseDurationMs: 3_600_000 }),
    ).not.toThrow();
  });
});

describe("local_ai profile", () => {
  const localAi = {
    direct_scenes: handler,
    review_frames: handler,
    generate_plates: handler,
    upscale_assets: handler,
  };
  const base = { ffmpeg: false, tts: false, scene_clips: false };

  it("registers only the local-AI jobs whose capability was verified", () => {
    expect(
      Object.keys(
        selectHandlers({
          handlers: { ...every, ...localAi },
          profile: "local_ai",
          capabilities: { ...base, verified: ["scene_director", "upscale"] },
        }),
      ).sort(),
    ).toEqual(["direct_scenes", "upscale_assets"]);
  });

  it("claims nothing when no model is verified, and refuses an unverified explicit job", () => {
    const select = (jobs?: string[]) => () =>
      selectHandlers({
        handlers: localAi,
        profile: "local_ai",
        jobs,
        capabilities: { ...base, verified: [] },
      });
    expect(select()).toThrow("worker_no_jobs");
    expect(select(["generate_plates"])).toThrow("worker_job_unavailable:generate_plates");
    expect(select(["render_reel"])).toThrow("worker_jobs_invalid:render_reel");
  });

  it("is exclusive: full and render_only never register local-AI jobs", () => {
    const capabilities = { ...capable, verified: ["scene_director", "visual_qa"] as const };
    for (const profile of ["full", "render_only"] as const)
      expect(
        Object.keys(selectHandlers({ handlers: { ...every, ...localAi }, profile, capabilities })),
      ).not.toContain("direct_scenes");
    expect(() =>
      selectHandlers({
        handlers: { ...every, ...localAi },
        profile: "full",
        jobs: ["direct_scenes"],
        capabilities,
      }),
    ).toThrow("worker_jobs_invalid:direct_scenes");
  });

  it("refuses a non-loopback database until D4 (restricted home-worker role) is decided", () => {
    const url = (host: string) => `postgresql://u:p@${host}:5432/db`;
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      expect(() => assertLocalAiDatabase(url(host))).not.toThrow();
    expect(() => assertLocalAiDatabase(url("ep-x.neon.tech"))).toThrow(
      "worker_local_ai_requires_local_database",
    );
    expect(() => assertLocalAiDatabase("not a url")).toThrow(
      "worker_local_ai_requires_local_database",
    );
    // pg lets a query parameter override the host: that must not pass (review fix).
    for (const bypass of [
      "postgresql://u:p@localhost:5432/db?host=ep-x.neon.tech",
      "postgresql://u:p@localhost:5432/db?sslmode=require&HOSTADDR=10.0.0.1",
      "mysql://u:p@localhost:3306/db",
    ])
      expect(() => assertLocalAiDatabase(bypass)).toThrow(
        "worker_local_ai_requires_local_database",
      );
    expect(() =>
      assertLocalAiDatabase("postgresql://u:p@localhost:5432/db?sslmode=disable"),
    ).not.toThrow();
  });
});
