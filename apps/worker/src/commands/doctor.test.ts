import { describe, expect, it } from "vitest";
import {
  classifyUrl,
  type DoctorDeps,
  formatDoctor,
  parseDoctorArgs,
  runDoctor,
} from "./doctor.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const SECRETS = [
  "sk-live-SECRET123",
  "p4ssw0rd-hunter2",
  "cf-token-ABCDEF",
  "agnes-key-XYZ",
  "r2-secret-QQQ",
  "db.internal.example",
];
const args = { json: false, strict: false, workspace: undefined };

const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
  env: {},
  now: () => NOW,
  fetch: (async () => new Response("ok", { status: 200 })) as typeof fetch,
  hasBinary: async () => true,
  fontsPresent: () => true,
  hyperframesPresent: async () => false,
  verifiedModels: async () => [],
  ...over,
});
const status = (report: Awaited<ReturnType<typeof runDoctor>>, label: string) =>
  report.rows.find((entry) => entry.label === label)?.status;
const backend = (report: Awaited<ReturnType<typeof runDoctor>>, cap: string, id: string) =>
  report.capabilities.find((c) => c.capability === cap)?.backends.find((b) => b.id === id);

describe("doctor", () => {
  it("reports unconfigured everywhere on an empty environment and still exits cleanly", async () => {
    const report = await runDoctor(deps(), args);
    expect(status(report, "Database")).toBe("NOT CONFIGURED");
    expect(status(report, "Scene Director")).toBe("NOT CONFIGURED");
    expect(status(report, "Paperclip")).toBe("NOT CONFIGURED");
    expect(status(report, "HyperFrames")).toBe("NOT CONFIGURED");
    expect(status(report, "Wan Video")).toBe("DISABLED");
    expect(report.strictFailure).toBe(true);
    expect(formatDoctor(report)).toContain("image_generation\n    1. home_worker:sd.cpp");
  });

  it("marks reachable loopback runtimes healthy and unreachable ones offline", async () => {
    const report = await runDoctor(
      deps({
        env: { SCENE_DIRECTOR_URL: "http://127.0.0.1:8080", TTS_URL: "http://127.0.0.1:8880" },
        fetch: (async (url: URL) => {
          if (url.port === "8880") throw new Error("down");
          return new Response("ok");
        }) as typeof fetch,
      }),
      args,
    );
    expect(status(report, "Scene Director")).toBe("HEALTHY");
    expect(status(report, "Kokoro")).toBe("OFFLINE");
    expect(backend(report, "scene_direction", "local:scene-director")?.state).toBe("ok");
    expect(backend(report, "tts", "local:kokoro")?.state).toBe("offline");
  });

  it("never sends a request to a public host", async () => {
    let called = false;
    const report = await runDoctor(
      deps({
        env: { COPYWRITER_URL: "https://api.example.com" },
        fetch: (async () => {
          called = true;
          return new Response("ok");
        }) as typeof fetch,
      }),
      args,
    );
    expect(called).toBe(false);
    expect(status(report, "Copywriting")).toBe("OFFLINE");
  });

  it("blocks Workers AI and Agnes under local_only", async () => {
    const report = await runDoctor(
      deps({
        env: {
          GENERATION_POLICY: "local_only",
          CLOUDFLARE_ACCOUNT_ID: "a",
          CLOUDFLARE_API_TOKEN: "t",
          CLOUDFLARE_AI_GATEWAY: "g",
          AGNES_API_KEY: "k",
        },
      }),
      args,
    );
    expect(backend(report, "image_generation", "workers_ai:flux-1-schnell")?.state).toBe(
      "policy_blocked",
    );
    expect(backend(report, "video_generation", "agnes_hosted")?.state).toBe("policy_blocked");
    expect(status(report, "generation policy")).toBe("LOCAL_ONLY");
  });

  it("reads home workers by heartbeat age and connection counts, with a database", async () => {
    const report = await runDoctor(
      deps({
        env: { DATABASE_URL: "postgres://u:p4ssw0rd-hunter2@db.internal.example/db" },
        database: {
          ping: async () => undefined,
          activeConnections: async () => ({ mercado_livre: 2 }),
          homeTokens: async () => [
            {
              heartbeatAt: new Date(NOW.getTime() - 60_000),
              capabilities: ["image_generation"],
              runtimes: { image_generation: "healthy" },
            },
            { heartbeatAt: new Date(NOW.getTime() - 3_600_000), capabilities: [], runtimes: {} },
          ],
        },
      }),
      args,
    );
    expect(status(report, "Database")).toBe("HEALTHY");
    expect(status(report, "Mercado Livre")).toBe("HEALTHY");
    expect(status(report, "Post for Me")).toBe("NOT CONFIGURED");
    expect(status(report, "home-worker")).toBe("ONLINE");
    expect(backend(report, "image_generation", "home_worker:sd.cpp")?.state).toBe("experimental");
    expect(report.strictFailure).toBe(false);
  });

  it("turns a failing or hanging database into OFFLINE instead of throwing", async () => {
    const report = await runDoctor(
      deps({
        env: { DATABASE_URL: "postgres://x" },
        database: {
          ping: async () => {
            throw new Error("boom");
          },
          activeConnections: async () => ({}),
          homeTokens: async () => [],
        },
      }),
      args,
    );
    expect(status(report, "Database")).toBe("OFFLINE");
    expect(status(report, "Mercado Livre")).toBe("OFFLINE");
  });

  it("reports Wan only when explicitly enabled and fails honestly when ffmpeg is missing", async () => {
    const report = await runDoctor(
      deps({
        env: { LOCAL_VIDEO_ENABLED: "true", VIDEO_GEN_URL: "http://10.0.0.5:9000" },
        hasBinary: async (name) => name === "ffmpeg",
      }),
      args,
    );
    expect(status(report, "Wan Video")).toBe("DISABLED");
    expect(status(report, "stickman_motion")).toBe("FAILED");
  });

  it("emits a JSON-shaped report and never leaks secret-looking values", async () => {
    const report = await runDoctor(
      deps({
        env: {
          DATABASE_URL: `postgres://user:${SECRETS[1]}@${SECRETS[5]}/db`,
          OPENAI_API_KEY: SECRETS[0],
          CLOUDFLARE_API_TOKEN: SECRETS[2],
          CLOUDFLARE_ACCOUNT_ID: "acct",
          CLOUDFLARE_AI_GATEWAY: "gw",
          AGNES_API_KEY: SECRETS[3],
          R2_ACCOUNT_ID: "a",
          R2_ACCESS_KEY_ID: "b",
          R2_SECRET_ACCESS_KEY: SECRETS[4],
          R2_BUCKET: "bucket",
          SCENE_DIRECTOR_URL: `http://user:${SECRETS[1]}@127.0.0.1:8081`,
          COPYWRITER_URL: `https://${SECRETS[5]}/${SECRETS[0]}`,
          PAPERCLIP_URL: `https://paperclip.example/${SECRETS[2]}`,
        },
        database: {
          ping: async () => undefined,
          activeConnections: async () => ({}),
          homeTokens: async () => [],
        },
      }),
      { json: true, strict: false, workspace: "ws-1" },
    );
    const json = JSON.stringify({ rows: report.rows, capabilities: report.capabilities });
    const parsed = JSON.parse(json);
    expect(parsed.rows[0]).toEqual(
      expect.objectContaining({ group: "Core", label: "Database", status: "HEALTHY" }),
    );
    expect(parsed.capabilities).toHaveLength(12);
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
      expect(formatDoctor(report)).not.toContain(secret);
    }
    expect(status(report, "Paperclip")).toBe("CONFIGURED");
  });
});

describe("classifyUrl and parseDoctorArgs", () => {
  it("prints only the host class", () => {
    expect(classifyUrl("http://localhost:8080/x")).toBe("loopback:8080");
    expect(classifyUrl("http://192.168.1.4:1")).toBe("private");
    expect(classifyUrl("https://example.com")).toBe("public");
    expect(classifyUrl("nope")).toBe("invalid");
  });

  it("parses flags and rejects unknown ones", () => {
    expect(parseDoctorArgs(["--json", "--strict", "--workspace", "w"])).toEqual({
      json: true,
      strict: true,
      workspace: "w",
    });
    expect(() => parseDoctorArgs(["--x"])).toThrow("unknown_argument:--x");
  });
});
