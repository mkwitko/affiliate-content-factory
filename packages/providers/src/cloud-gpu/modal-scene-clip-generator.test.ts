import { createHash } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import type { RemoteGpuJobRequest } from "@money-maker/contracts/cloud-gpu-job";
import type { SceneClipRequest } from "@money-maker/core/assets/scene-clip-generator";
import type { ModalShape } from "@money-maker/core/cloud-gpu/modal-quote";
import { modalQuote } from "@money-maker/core/cloud-gpu/modal-quote";
import {
  type BudgetPolicy,
  CLOUD_GPU_PILOT_BUDGET,
  createInMemoryGenerationBudgetLedger,
  quoteBrlMinor,
} from "@money-maker/core/costs/generation-budget";
import { freeCreditPolicy, paidBudgetPolicy } from "@money-maker/core/costs/generation-settings";
import { describe, expect, it } from "vitest";
import {
  type ClipObjectStore,
  createModalSceneClipGenerator,
  createR2ClipObjectStore,
  MODAL_PILOT,
  type ModalCalls,
  verifyModalCredentials,
} from "./modal-scene-clip-generator.js";

const now = new Date("2026-10-15T12:00:00Z");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const policy: BudgetPolicy = { ...CLOUD_GPU_PILOT_BUDGET, providers: ["modal"] };
const shape: ModalShape = {
  gpu: "A100-80GB",
  cpuCores: 4,
  memoryGiB: 32,
  timeoutSeconds: 600,
  coldStartSeconds: 240,
};
const model = { id: "wan2.2-i2v-a14b", revision: "596658fd9ca6b7b71d5057529bbf319ecbc61d74" };
const plate = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);
const clip = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4, 5]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const secrets = [
  "postgres://user:pw@neon",
  "r2-secret-access-key",
  "pfm_live",
  "modal-token-secret",
];

type Mode = "ok" | "spawn_throws" | "error" | "hang" | "forged" | "wrong_checksum" | "no_output";

const setup = (
  mode: Mode = "ok",
  options: { policy?: BudgetPolicy; policies?: readonly BudgetPolicy[] } = {},
) => {
  const objects = new Map<string, Uint8Array>();
  const store: ClipObjectStore = {
    uploadUrl: async (key) => `https://acct.r2.cloudflarestorage.com/b/${key}?X-Amz-Signature=up`,
    downloadUrl: async (key) =>
      `https://acct.r2.cloudflarestorage.com/b/${key}?X-Amz-Signature=down`,
    read: async (key, max) => {
      const bytes = objects.get(key);
      return bytes && bytes.byteLength <= max ? bytes : null;
    },
  };
  const spawned: RemoteGpuJobRequest[] = [];
  const calls: ModalCalls = {
    spawn: async (request) => {
      if (mode === "spawn_throws") throw new Error("grpc unavailable");
      spawned.push(request);
      const key = decodeURIComponent(new URL(request.output.url).pathname.replace("/b/", ""));
      if (mode !== "no_output") objects.set(key, clip);
      return `fc-${spawned.length}`;
    },
    result: async () => {
      if (mode === "hang") return { status: "pending" };
      if (mode === "error") return { status: "error" };
      const request = spawned.at(-1) as RemoteGpuJobRequest;
      return {
        status: "done",
        value: {
          jobId: request.jobId,
          operationKey: request.operationKey,
          provider: mode === "forged" ? "someone-else" : "modal",
          runId: "run-1",
          model: request.model,
          output: {
            sha256: mode === "wrong_checksum" ? "0".repeat(64) : sha(clip),
            bytes: clip.byteLength,
            mimeType: "video/mp4",
            width: 720,
            height: 1280,
            fps: 16,
            durationMs: 5_063,
          },
          billing: { currency: "USD", minor: 0, billedSeconds: 300 },
        },
      };
    },
    cancel: async () => undefined,
  };
  let clock = now;
  const ledger = createInMemoryGenerationBudgetLedger();
  const generator = createModalSceneClipGenerator({
    calls,
    store,
    ledger,
    policies: options.policies ?? [options.policy ?? policy],
    shape,
    model,
    fx: async () => ({ brlPerUsd: 5.6, source: "bcb-ptax-venda:test", at: now }),
    now: () => clock,
  });
  const request = (operationKey = "scene-clip:r1:1:3:1"): SceneClipRequest => ({
    prompt: "Sam pushes a cart down a supermarket aisle, slow push-in",
    negativePrompt: "text, extra people",
    mode: "image",
    referenceImageUrls: ["https://acct.r2.cloudflarestorage.com/b/plate?X-Amz-Signature=r"],
    referenceChecksums: [`sha256:${sha(plate)}`],
    width: 720,
    height: 1280,
    seconds: 5,
    budget: { workspaceId, operationKey },
  });
  const rows = () => ledger.list({ workspaceId, budgetKey: policy.key });
  return {
    generator,
    request,
    spawned,
    rows,
    ledger,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
};

describe("Modal scene clip generator", () => {
  it("reserves the worst case, spawns once and settles the metered cost on completion", async () => {
    const { generator, request, spawned, rows } = setup();
    const task = await generator.submit(request());
    expect(spawned).toHaveLength(1);
    expect(await rows()).toMatchObject([
      { status: "reserved", estimatedMinor: 426, receipt: "modal:fc-1" },
    ]);
    const polled = await generator.poll(task);
    expect(polled).toEqual({
      status: "completed",
      url: expect.stringMatching(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/b\/workspaces\//),
    });
    // 300 s + 240 s cold start of 840 s quoted: 426 x 45 / 69 -> 278 centavos.
    expect(await rows()).toMatchObject([
      { status: "settled", actualMinor: 278, receipt: "modal:fc-1:metered-estimate" },
    ]);
  });

  it("sends only the strict request: no credentials, signed R2 URLs, pinned model", async () => {
    const { generator, request, spawned } = setup();
    await generator.submit(request());
    const wire = JSON.stringify(spawned[0]);
    for (const secret of secrets) expect(wire).not.toContain(secret);
    expect(spawned[0]).toMatchObject({
      model,
      clip: { width: 720, height: 1280, fps: 16, seconds: 5 },
      inputs: [{ sha256: sha(plate) }],
      attempt: 1,
    });
  });

  it("refuses before any spend without budget context, a reference or a five-second scene", async () => {
    const { generator, request, spawned, rows } = setup();
    const { budget: _budget, ...noBudget } = request();
    await expect(generator.submit(noBudget)).rejects.toMatchObject({
      code: "modal_budget_context_missing",
      retryable: false,
    });
    await expect(
      generator.submit({ ...request(), mode: "text", referenceImageUrls: [] }),
    ).rejects.toMatchObject({
      code: "modal_reference_required",
    });
    await expect(generator.submit({ ...request(), seconds: 9 })).rejects.toMatchObject({
      code: "modal_duration_unsupported",
    });
    expect(spawned).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("refuses when the budget refuses (here, a cap below one generation)", async () => {
    const { generator, request, spawned } = setup("ok", { policy: { ...policy, capMinor: 400 } });
    await expect(generator.submit(request())).rejects.toMatchObject({
      code: "budget_budget_exhausted",
      retryable: false,
    });
    expect(spawned).toHaveLength(0);
  });

  it("resumes the same call when the same operation is submitted again", async () => {
    const { generator, request, spawned } = setup();
    const first = await generator.submit(request());
    const again = await generator.submit(request());
    expect(spawned).toHaveLength(1);
    expect(again.providerTaskId).not.toBe(first.providerTaskId);
    expect(await generator.poll(again)).toMatchObject({ status: "completed" });
  });

  it.each([
    ["error", "modal_failed"],
    ["forged", "modal_result_invalid"],
  ] as const)(
    "holds the charge as unknown after %s and blocks the next paid run",
    async (mode, code) => {
      const { generator, request, rows } = setup(mode);
      const task = await generator.submit(request());
      expect(await generator.poll(task)).toEqual({ status: "failed", code, retryable: false });
      expect(await rows()).toMatchObject([{ status: "unresolved", estimatedMinor: 426 }]);
      await expect(generator.submit(request("scene-clip:r1:1:4:1"))).rejects.toMatchObject({
        code: "budget_unknown_outcome_pending",
      });
    },
  );

  it("holds the charge as unknown when spawn fails without a call id", async () => {
    const { generator, request, rows } = setup("spawn_throws");
    await expect(generator.submit(request())).rejects.toMatchObject({
      code: "modal_spawn_unknown",
    });
    expect(await rows()).toMatchObject([{ status: "unresolved" }]);
  });

  it("stays pending until the call outlives its timeout, then cancels and holds it unknown", async () => {
    const { generator, request, rows, advance } = setup("hang");
    const task = await generator.submit(request());
    expect(await generator.poll(task)).toEqual({ status: "pending" });
    advance((600 + 240 + 600) * 1000 + 1);
    expect(await generator.poll(task)).toMatchObject({ status: "failed", code: "modal_timeout" });
    expect(await rows()).toMatchObject([{ status: "unresolved" }]);
  });

  it.each([
    ["wrong_checksum", "modal_output_checksum"],
    ["no_output", "modal_output_missing"],
  ] as const)("records the spend but rejects a bad output (%s)", async (mode, code) => {
    const { generator, request, rows } = setup(mode);
    const task = await generator.submit(request());
    expect(await generator.poll(task)).toEqual({ status: "failed", code, retryable: false });
    expect(await rows()).toMatchObject([{ status: "settled", actualMinor: 278 }]);
  });
});

describe("Modal free credit before the paid month", () => {
  const free = freeCreditPolicy("modal", { amountMinor: 3_000, currency: "USD" }, now);
  const paid = paidBudgetPolicy({ monthlyCapMinor: 10_000, freeCredits: {} }, ["modal"], now);

  it("reserves on the free credit while it covers the worst case", async () => {
    const { generator, request, ledger } = setup("ok", { policies: [free, paid] });
    await generator.submit(request());
    const [entry] = await ledger.list({ workspaceId, budgetKey: free.key });
    expect(entry?.status).toBe("reserved");
    expect(await ledger.list({ workspaceId, budgetKey: paid.key })).toEqual([]);
  });

  it("moves to the paid month when the free credit cannot cover the run", async () => {
    const { generator, request, ledger, spawned } = setup("ok", {
      policies: [{ ...free, capMinor: 1 }, paid],
    });
    await generator.submit(request());
    expect(spawned).toHaveLength(1);
    expect(await ledger.list({ workspaceId, budgetKey: free.key })).toEqual([]);
    expect((await ledger.list({ workspaceId, budgetKey: paid.key }))[0]?.status).toBe("reserved");
  });

  it("refuses before any spawn when no policy admits the run", async () => {
    const { generator, request, spawned } = setup("ok", { policies: [] });
    await expect(generator.submit(request())).rejects.toMatchObject({
      code: "budget_provider_unsupported",
    });
    expect(spawned).toEqual([]);
  });
});

describe("verifyModalCredentials", () => {
  const credentials = { tokenId: "ak-1", tokenSecret: "as-1" };
  class NotFound extends Error {}
  const isNotFound = async (error: unknown) => error instanceof NotFound;

  it("tells a working token, an undeployed app and a bad token apart", async () => {
    expect(await verifyModalCredentials(credentials, async () => undefined, isNotFound)).toBe(
      "deployed",
    );
    expect(
      await verifyModalCredentials(
        credentials,
        async () => {
          throw new NotFound();
        },
        isNotFound,
      ),
    ).toBe("app_missing");
    expect(
      await verifyModalCredentials(
        credentials,
        async () => {
          throw new Error("UNAUTHENTICATED");
        },
        isNotFound,
      ),
    ).toBe("invalid");
  });
});

describe("R2 clip object store", () => {
  it("signs a video/mp4 upload and refuses a read over the byte limit", async () => {
    const signed: unknown[] = [];
    const store = createR2ClipObjectStore(
      {
        createUploadUrl: async (input) => {
          signed.push(input);
          return "https://acct.r2.cloudflarestorage.com/up";
        },
        createDownloadUrl: async () => "https://acct.r2.cloudflarestorage.com/down",
      },
      async () => new Response(new Uint8Array(20), { headers: { "content-length": "20" } }),
    );
    await store.uploadUrl("k", 60);
    expect(signed).toEqual([
      { key: "k", contentType: "video/mp4", metadata: {}, expiresInSeconds: 60 },
    ]);
    expect(await store.read("k", 10)).toBeNull();
    expect(await store.read("k", 20)).toHaveLength(20);
  });
});

describe("MODAL_PILOT", () => {
  const worst = (brlPerUsd: number) =>
    quoteBrlMinor(
      modalQuote({
        shape: MODAL_PILOT.shape,
        model: MODAL_PILOT.model.id,
        revision: MODAL_PILOT.model.revision,
        fx: { brlPerUsd, source: "test", at: now },
        now,
      }),
    );
  it("prices one hour on the A100 plus cold start at about R$17 at today's PTAX", () => {
    // (2.50 + 4 x 0.0473 + 32 x 0.008) $/h x (3600 + 240) s = 314.15 cents -> 315.
    expect(worst(4.9892)).toBe(1729);
  });
});
