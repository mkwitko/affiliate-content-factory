import { createHash, randomUUID } from "node:crypto";
import { parseUserId, parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Asset } from "../assets/asset.js";
import { directorPlanFrom } from "../content/director-plan.js";
import { createContentScript } from "../content/editorial.js";
import type { SceneSpec } from "../explainer/scene-spec.js";
import type { ClaimedJob } from "../jobs/job.js";
import type { Niche } from "../niches/niche.js";
import { applyHomeResult, claimHomeTask, failHomeTask, type HomeTaskDeps } from "./tasks.js";
import {
  authenticateHomeWorker,
  describeToken,
  type HomeWorkerToken,
  issueHomeWorkerToken,
} from "./tokens.js";

const ws = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const otherWs = parseWorkspaceId("33333333-3333-4333-8333-333333333333");
const hash = async (plain: string) => createHash("sha256").update(plain).digest("hex");
const now = () => new Date("2026-10-01T12:00:00Z");

const tokenWith = (capabilities: HomeWorkerToken["capabilities"]): HomeWorkerToken => ({
  id: "tok-1",
  workspaceId: ws,
  name: "desktop",
  tokenHash: "h",
  prefix: "mmhw_abcdef",
  capabilities,
  createdById: "user-1",
  createdAt: now(),
  lastUsedAt: null,
  revokedAt: null,
});

describe("home worker tokens", () => {
  it("issues a prefixed token, stores only its hash and keeps known capabilities", async () => {
    const create = vi.fn(async (token: HomeWorkerToken) => token);
    const { plain, token } = await issueHomeWorkerToken(
      { create },
      { random: () => "x".repeat(43), hash, now, id: () => "tok-9" },
      {
        workspaceId: ws,
        name: "  RX desktop ",
        capabilities: ["visual_qa", "visual_qa"],
        createdById: "u",
      },
    );
    expect(plain.startsWith("mmhw_")).toBe(true);
    expect(token.tokenHash).toBe(await hash(plain));
    expect(token.tokenHash).not.toContain(plain);
    expect(token).toMatchObject({
      name: "RX desktop",
      capabilities: ["visual_qa"],
      prefix: plain.slice(0, 11),
    });
    expect(describeToken(token)).not.toHaveProperty("tokenHash");
    await expect(
      issueHomeWorkerToken(
        { create },
        { random: () => "x", hash, now, id: () => "t" },
        { workspaceId: ws, name: "n", capabilities: [], createdById: "u" },
      ),
    ).rejects.toThrow("home_token_capabilities_required");
  });

  it("authenticates live tokens only and refreshes last use at most once a minute", async () => {
    const plain = `mmhw_${"y".repeat(43)}`;
    const stored = { ...tokenWith(["visual_qa"]), tokenHash: await hash(plain) };
    const touch = vi.fn(async () => undefined);
    const repo = {
      findByHash: async (h: string) => (h === stored.tokenHash ? stored : null),
      touch,
    };
    await expect(authenticateHomeWorker(repo, { hash, now }, plain)).resolves.toMatchObject({
      id: "tok-1",
    });
    expect(touch).toHaveBeenCalledOnce();
    await expect(
      authenticateHomeWorker(repo, { hash, now }, `mmhw_${"z".repeat(43)}`),
    ).resolves.toBeNull();
    await expect(authenticateHomeWorker(repo, { hash, now }, "Bearer nope")).resolves.toBeNull();
    const revoked = { findByHash: async () => ({ ...stored, revokedAt: now() }), touch };
    await expect(authenticateHomeWorker(revoked, { hash, now }, plain)).resolves.toBeNull();
    const recent = {
      findByHash: async () => ({ ...stored, lastUsedAt: new Date(now().getTime() - 10_000) }),
      touch,
    };
    touch.mockClear();
    await authenticateHomeWorker(recent, { hash, now }, plain);
    expect(touch).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ tasks

const sentences = [
  "Essa air fryer custa R$ 329,90 hoje.",
  "A Carla comparou três modelos antes de comprar.",
  "No fim, o cesto grande resolveu o jantar da família.",
];
const body = sentences.join(" ");
const script = {
  ...createContentScript({
    workspaceId: ws,
    contentItemId: "item-1",
    version: 1,
    body,
    language: "pt-BR",
    claims: [
      {
        text: "Preço de R$ 329,90.",
        kind: "verified_fact",
        evidence: [{ kind: "commercial_fact", snapshotId: "snap-1", key: "price" }],
      },
    ],
    beats: [
      { kind: "hook", atChar: 0, label: "money_question" },
      { kind: "payoff", atChar: 90 },
    ],
    actorId: parseUserId("22222222-2222-4222-8222-222222222222"),
  }),
  status: "approved" as const,
};
const starts = sentences.map((sentence) => body.indexOf(sentence));
const cameras = [
  { shot: "medium", movement: "none" },
  { shot: "close", movement: "push_in" },
  { shot: "wide", movement: "slow_zoom_out" },
] as const;
const scene = (index: number, over: Partial<SceneSpec> = {}): SceneSpec => ({
  index,
  fromChar: starts[index - 1] ?? 0,
  toChar: starts[index] ?? body.length,
  purpose: "explanation",
  background: "kitchen",
  actors: [{ characterKey: "alex", pose: "neutral", expression: "neutral", position: "center" }],
  props: [],
  overlays: [],
  camera: cameras[(index - 1) % 3] as SceneSpec["camera"],
  transition: "hard_cut",
  captionMode: "word",
  ...over,
});
const goodScenes = [
  scene(1, { purpose: "hook" }),
  scene(2, { background: "store" }),
  scene(3, { purpose: "payoff" }),
];
const niche: Niche = {
  id: "niche-1",
  workspaceId: ws,
  name: "Media",
  audience: "a",
  problem: "p",
  editorialVoice: "v",
  languages: ["pt-BR"],
  monetizationHypothesis: "m",
  state: "active",
  kind: "media",
  context: {
    voiceId: "pf_dora",
    characters: [
      {
        key: "alex",
        name: "Alex",
        role: "main",
        rigId: "stick-v1",
        rigVersion: 1,
        palette: { line: "#161616", fill: "#ffffff", accent: "#ff5a36" },
      },
    ],
    explainer: {
      style: "sketch_watercolor",
      locations: [
        { id: "office_a", name: "Office", proceduralFallback: "office", zones: [], anchors: [] },
      ],
    },
  },
};

type FakeJob = ClaimedJob & {
  status: "pending" | "running" | "done" | "failed" | "retry";
  reason?: string;
};
const harness = (jobs: FakeJob[]) => {
  const created: unknown[] = [];
  const assets: Asset[] = [];
  const recorded: unknown[] = [];
  const queue: HomeTaskDeps["queue"] = {
    claim: vi.fn(async (input) => {
      const job = jobs.find(
        (entry) =>
          entry.status === "pending" &&
          input.names.includes(entry.name) &&
          (!input.workspaceId || entry.workspaceId === input.workspaceId),
      );
      if (!job) return null;
      job.status = "running";
      return job;
    }),
    takeLease: async (input) => {
      const job = jobs.find(
        (entry) =>
          entry.id === input.id &&
          entry.workspaceId === input.workspaceId &&
          entry.leaseToken === input.leaseToken &&
          entry.status === "running",
      );
      if (!job) return null;
      Object.assign(job, { leaseToken: randomUUID() });
      return { ...job };
    },
    complete: async (input) => {
      const job = jobs.find((entry) => entry.id === input.id);
      if (job) job.status = "done";
    },
    retry: async (input) => {
      const job = jobs.find((entry) => entry.id === input.id);
      if (job) Object.assign(job, { status: "retry", reason: input.reason });
    },
    failPermanently: async (input) => {
      const job = jobs.find((entry) => entry.id === input.id);
      if (job) Object.assign(job, { status: "failed", reason: input.reason });
    },
  };
  const deps: HomeTaskDeps = {
    queue,
    leaseDurationMs: 60_000,
    scripts: {
      findScriptForWorkspace: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
        workspaceId === ws ? script : null,
    } as never,
    content: {
      findContentItemForWorkspace: async () => ({ id: "item-1", nicheId: "niche-1" }),
    } as never,
    niches: {
      findForWorkspace: async ({ workspaceId }: { workspaceId: WorkspaceId }) =>
        workspaceId === ws ? niche : null,
    } as never,
    storyboards: {
      findLatestForScript: async () => null,
      create: async (board: unknown) => (created.push(board), board),
    } as never,
    renders: {
      findForWorkspace: async () => ({
        id: "render-1",
        status: "ready",
        assetId: "video-1",
        timingManifest: {
          renderedAssetChecksum: "sum",
          scenes: [
            { index: 1, startMs: 0, endMs: 2_000 },
            { index: 2, startMs: 2_000, endMs: 4_000 },
          ],
        },
        qualityReport: {
          version: 1,
          verdict: "pass",
          checks: [],
          measuredAt: "x",
          visual: { findings: [{ id: "caption_contrast", severity: "BLOCK" }], colorStrip: [] },
        },
      }),
      recordVisualReview: async (input: unknown) => (recorded.push(input), {}),
    } as never,
    assets: {
      findForWorkspace: async () => ({
        id: "video-1",
        workspaceId: ws,
        state: "active",
        mimeType: "video/mp4",
        checksum: "sum",
      }),
    } as never,
    store: { createDownload: async () => ({ url: "https://r2.example/signed?x=1" }) } as never,
    bank: {
      assets: {
        listByMetadata: async ({
          value,
          state = "active",
        }: {
          value: string;
          state?: Asset["state"];
        }) => assets.filter((asset) => asset.metadata?.sceneKey === value && asset.state === state),
        create: async (asset: Asset) => (assets.push(asset), asset),
        updateState: async ({ assetId, state }: { assetId: string; state: Asset["state"] }) => {
          const index = assets.findIndex((asset) => asset.id === assetId);
          const updated = { ...(assets[index] as Asset), state };
          assets[index] = updated;
          return updated;
        },
        updateMetadata: async () => null,
      },
      store: { putObject: async () => undefined },
      usage: { sum: async () => 0, record: async () => undefined },
      budget: () => "generate",
      now,
    } as never,
    reencodeImage: async (bytes) => ({
      bytes,
      mimeType: bytes[0] === 0xff ? "image/jpeg" : "text/plain",
      width: 1216,
      height: 1344,
    }),
    now,
  };
  return { deps, created, assets, recorded };
};
const job = (
  name: string,
  identifiers: Record<string, string>,
  workspaceId: WorkspaceId = ws,
  id = `job-${name}`,
): FakeJob => ({
  id,
  workspaceId,
  name,
  payload: { version: 1, workspaceId, identifiers },
  leaseToken: `lease-${id}`,
  idempotencyKey: id,
  attemptCount: 1,
  status: "pending",
});

describe("claimHomeTask", () => {
  it("claims only the token's workspace and capabilities", async () => {
    const jobs = [
      job(
        "direct_scenes",
        { scriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        otherWs,
        "foreign",
      ),
      job("review_frames", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    ];
    const { deps } = harness(jobs);
    const task = await claimHomeTask(deps, tokenWith(["visual_qa"]));
    expect(deps.queue.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        names: ["review_frames", "check_scene_fidelity"],
        workspaceId: ws,
        workerId: "home:tok-1",
      }),
    );
    expect(task).toMatchObject({
      kind: "review_frames",
      videoUrl: "https://r2.example/signed?x=1",
      frames: [{ sceneIndex: 1, hook: true }, { sceneIndex: 1 }, { sceneIndex: 2 }],
    });
    expect(jobs[0]?.status).toBe("pending");
  });

  it("prefers the jobs of the model the machine has loaded, and ignores a capability it lacks", async () => {
    const { deps } = harness([]);
    await claimHomeTask(deps, tokenWith(["visual_qa", "image_editing"]), 5, "visual_qa");
    expect(deps.queue.claim).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferNames: ["review_frames", "check_scene_fidelity"] }),
    );
    await claimHomeTask(deps, tokenWith(["visual_qa"]), 5, "image_editing");
    expect(deps.queue.claim).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ preferNames: expect.anything() }),
    );
  });

  it("sends a director task with the script and catalog, and plate tasks with only missing plates", async () => {
    const { deps } = harness([
      job("direct_scenes", { scriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      job("generate_plates", { nicheId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    ]);
    const direction = await claimHomeTask(deps, tokenWith(["scene_director"]));
    expect(direction).toMatchObject({ kind: "direct_scenes", input: { script: { body } } });
    const plates = await claimHomeTask(deps, tokenWith(["image_generation"]));
    expect(plates).toMatchObject({ kind: "generate_plates" });
    expect(plates?.kind === "generate_plates" ? plates.requests.map((r) => r.key) : []).toContain(
      "niche-1:location:office_a:sketch_watercolor:t1",
    );
  });

  it("fails a job that cannot become a task and moves on", async () => {
    const jobs = [
      job("direct_scenes", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, ws, "broken"),
      job("direct_scenes", { scriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, ws, "ok"),
    ];
    const { deps } = harness(jobs);
    const task = await claimHomeTask(deps, tokenWith(["scene_director"]));
    expect(jobs[0]).toMatchObject({ status: "failed", reason: "direction_script_id_missing" });
    expect(task?.jobId).toBe("ok");
  });
});

describe("applyHomeResult", () => {
  it("stores a director draft only after the server-side gate passes", async () => {
    const jobs = [job("direct_scenes", { scriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })];
    const { deps, created } = harness(jobs);
    const token = tokenWith(["scene_director"]);
    const task = await claimHomeTask(deps, token);
    const lease = { jobId: task?.jobId ?? "", leaseToken: task?.leaseToken ?? "" };
    await expect(
      applyHomeResult(deps, token, {
        ...lease,
        result: { kind: "direct_scenes", scenes: directorPlanFrom(goodScenes, body) },
      }),
    ).resolves.toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect(jobs[0]?.status).toBe("done");
  });

  it("refuses a director answer that writes its own overlay text, and writes nothing", async () => {
    const jobs = [job("direct_scenes", { scriptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })];
    const { deps, created } = harness(jobs);
    const token = tokenWith(["scene_director"]);
    const task = await claimHomeTask(deps, token);
    const lease = { jobId: task?.jobId ?? "", leaseToken: task?.leaseToken ?? "" };
    // A plan quotes the script by word range; free text does not pass the plan schema.
    const valid = directorPlanFrom(goodScenes, body);
    const invented = {
      segments: valid.segments.map((segment, index) =>
        index === 0 && segment.newScene
          ? {
              ...segment,
              visual: { ...segment.visual, overlays: [{ text: "COMPRE JÁ", position: "top" }] },
            }
          : segment,
      ),
    };
    const outcome = await applyHomeResult(deps, token, {
      ...lease,
      result: { kind: "direct_scenes", scenes: invented },
    });
    expect(outcome).toEqual({ ok: false, reason: "director_output_invalid" });
    expect(created).toHaveLength(0);
    expect(jobs[0]?.status).toBe("failed");
  });

  it("refuses results for another token's workspace, a wrong lease or the wrong kind", async () => {
    const jobs = [job("review_frames", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })];
    const { deps } = harness(jobs);
    const token = tokenWith(["visual_qa"]);
    const task = await claimHomeTask(deps, token);
    const review = {
      kind: "review_frames" as const,
      review: { record: { vlm: "reviewed" as const, latencyMs: 1 }, findings: [] },
    };
    await expect(
      applyHomeResult(deps, token, {
        jobId: task?.jobId ?? "",
        leaseToken: "stolen",
        result: review,
      }),
    ).resolves.toEqual({ ok: false, reason: "task_not_leased" });
    await expect(
      applyHomeResult(
        deps,
        { ...token, workspaceId: otherWs },
        { jobId: task?.jobId ?? "", leaseToken: task?.leaseToken ?? "", result: review },
      ),
    ).resolves.toEqual({ ok: false, reason: "task_not_leased" });
    await expect(
      applyHomeResult(deps, token, {
        jobId: task?.jobId ?? "",
        leaseToken: task?.leaseToken ?? "",
        result: { kind: "direct_scenes", scenes: [] },
      }),
    ).resolves.toEqual({ ok: false, reason: "result_kind_mismatch" });
  });

  it("appends review findings but refuses a BLOCK from the VLM; deterministic BLOCKs stay", async () => {
    const jobs = [
      job("review_frames", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, ws, "a"),
      job("review_frames", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, ws, "b"),
    ];
    const { deps, recorded } = harness(jobs);
    const token = tokenWith(["visual_qa"]);
    const first = await claimHomeTask(deps, token);
    const ok = await applyHomeResult(deps, token, {
      jobId: first?.jobId ?? "",
      leaseToken: first?.leaseToken ?? "",
      result: {
        kind: "review_frames",
        review: {
          record: { vlm: "reviewed", latencyMs: 5 },
          findings: [{ id: "vlm_clutter", severity: "WARN", sceneIndex: 2 }],
        },
      },
    });
    expect(ok).toEqual({ ok: true });
    // The lease was spent by the first post: a replay writes nothing.
    await expect(
      applyHomeResult(deps, token, {
        jobId: first?.jobId ?? "",
        leaseToken: first?.leaseToken ?? "",
        result: { kind: "review_frames", review: { record: { vlm: "skipped" }, findings: [] } },
      }),
    ).resolves.toEqual({ ok: false, reason: "task_not_leased" });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      visual: {
        findings: [
          { id: "caption_contrast", severity: "BLOCK" },
          { id: "vlm_clutter", severity: "WARN" },
        ],
      },
    });
    const second = await claimHomeTask(deps, token);
    const blocked = await applyHomeResult(deps, token, {
      jobId: second?.jobId ?? "",
      leaseToken: second?.leaseToken ?? "",
      result: {
        kind: "review_frames",
        review: {
          record: { vlm: "reviewed", latencyMs: 5 },
          findings: [{ id: "x", severity: "BLOCK" }],
        },
      },
    });
    expect(blocked).toEqual({ ok: false, reason: "review_block_not_allowed" });
    expect(recorded).toHaveLength(1);
  });

  it("holds a posted plate for review with its provenance and refuses a non-allowlisted model", async () => {
    const jobs = [
      job("generate_plates", { nicheId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, ws, "p1"),
      job("generate_plates", { nicheId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, ws, "p2"),
      job("generate_plates", { nicheId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, ws, "p3"),
      job("generate_plates", { nicheId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, ws, "p4"),
    ];
    const { deps, assets } = harness(jobs);
    const token = tokenWith(["image_generation"]);
    const key = "niche-1:location:office_a:sketch_watercolor:t1";
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    const t1 = await claimHomeTask(deps, token);
    await expect(
      applyHomeResult(deps, token, {
        jobId: t1?.jobId ?? "",
        leaseToken: t1?.leaseToken ?? "",
        result: {
          kind: "generate_plates",
          plates: [{ key, bytes: jpeg, model: "local:wan2.2-ti2v-5b" }],
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "plate_model_not_allowlisted" });
    const t2 = await claimHomeTask(deps, token);
    await expect(
      applyHomeResult(deps, token, {
        jobId: t2?.jobId ?? "",
        leaseToken: t2?.leaseToken ?? "",
        result: {
          kind: "generate_plates",
          plates: [{ key, bytes: new Uint8Array([1, 2]), model: "local:z-image-turbo" }],
        },
      }),
    ).resolves.toEqual({ ok: false, reason: "plate_unreadable" });
    const t3 = await claimHomeTask(deps, token);
    await expect(
      applyHomeResult(deps, token, {
        jobId: t3?.jobId ?? "",
        leaseToken: t3?.leaseToken ?? "",
        result: {
          kind: "generate_plates",
          plates: [
            {
              key,
              bytes: jpeg,
              model: "local:z-image-turbo",
              seed: 7,
              provenance: { runtime: "stable-diffusion.cpp", observedModel: "Z Image observed" },
            },
          ],
        },
        workerVersion: "abc1234-dirty",
      }),
    ).resolves.toEqual({ ok: true });
    const plate = assets.find((asset) => asset.metadata?.sceneKey === key);
    // The declared model is not proof: no rights and no use until a human approves it.
    expect(plate).toMatchObject({
      state: "pending_review",
      commercialUse: null,
      creator: "local:z-image-turbo",
      metadata: {
        homeWorker: {
          status: "pending_review",
          tokenId: token.id,
          tokenPrefix: "mmhw_abcdef",
          jobId: t3?.jobId,
          capability: "image_generation",
          declaredModel: "local:z-image-turbo",
          workerVersion: "abc1234-dirty",
          inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          postedHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          generation: {
            provider: "local",
            runtime: "stable-diffusion.cpp",
            expectedModel: "unsloth/Z-Image-Turbo-GGUF",
            observedModel: "Z Image observed",
            promptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            workerId: token.id,
            validationResult: "pending_review",
          },
        },
      },
    });
    expect(plate?.license).toContain("declared local:z-image-turbo, home worker mmhw_abcdef");
    // A held plate fills its slot: the next task does not ask for the same plate again.
    const t4 = await claimHomeTask(deps, token);
    expect(t4?.kind === "generate_plates" ? t4.requests.map((r) => r.key) : []).not.toContain(key);
  });
});

describe("failHomeTask", () => {
  it("retries or fails only the task this token holds", async () => {
    const jobs = [job("review_frames", { renderId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })];
    const { deps } = harness(jobs);
    const token = tokenWith(["visual_qa"]);
    const task = await claimHomeTask(deps, token);
    await expect(
      failHomeTask(deps, token, {
        jobId: task?.jobId ?? "",
        leaseToken: "x",
        reason: "gpu",
        retryable: true,
      }),
    ).resolves.toEqual({ ok: false, reason: "task_not_leased" });
    await failHomeTask(deps, token, {
      jobId: task?.jobId ?? "",
      leaseToken: task?.leaseToken ?? "",
      reason: "model server down!",
      retryable: true,
    });
    expect(jobs[0]).toMatchObject({ status: "retry", reason: "home:model_server_down_" });
  });
});
