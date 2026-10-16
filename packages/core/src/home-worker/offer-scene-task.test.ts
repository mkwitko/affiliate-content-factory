import { randomUUID } from "node:crypto";
import { parseWorkspaceId, type UserId, type WorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { Asset } from "../assets/asset.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import { uuidFromKey } from "../content/offer-package.js";
import { MAX_OFFER_SCENE_ATTEMPTS } from "../creatives/offer-scenes.js";
import { rejectOfferScene } from "../creatives/reject-scene.js";
import type { ClaimedJob, EnqueueJobInput } from "../jobs/job.js";
import type { Offer } from "../offers/offer.js";
import { DEPTH_MODEL } from "./offer-scene-task.js";
import { applyHomeResult, claimHomeTask, type HomeResult, type HomeTaskDeps } from "./tasks.js";
import type { HomeWorkerToken } from "./tokens.js";

const ws = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const otherWs = parseWorkspaceId("22222222-2222-4222-8222-222222222222");
const offerId = "44444444-4444-4444-8444-444444444444";
const itemId = uuidFromKey(`auto-sale:${offerId}`);
const SHEET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PHOTO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PHOTO2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KLEIN = "local:flux-2-klein-4b";
const VLM = "local:qwen3-vl-4b";
const title = "Estante Plástica 3 Prateleiras Multiuso";

const token = (
  capabilities: HomeWorkerToken["capabilities"],
  workspaceId = ws,
): HomeWorkerToken => ({
  id: "tok",
  workspaceId,
  name: "n",
  tokenHash: "h",
  prefix: "mmhw_a",
  capabilities,
  createdById: "u",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
});
const CUTOUT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const offer = {
  id: offerId,
  workspaceId: ws,
  title,
  listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [
    {
      id: "s1",
      verifiedAt: new Date(),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 8990, currency: "BRL" },
          sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
          verified: true,
        },
      ],
    },
  ],
} as unknown as Offer;
const slides = Array.from({ length: 3 }, (_, i) => ({
  index: i + 1,
  total: 3,
  template: "benefit" as const,
  headline: i === 0 ? "Banheiro em ordem por R$ 89,90" : `Motivo ${i + 1}`,
  claims: [],
}));
/** Fake PNG: the first four bytes carry the size the fake re-encoder reports. */
const png = (width: number, height: number) =>
  new Uint8Array([width >> 8, width & 255, height >> 8, height & 255, 1, 2, 3]);
const image = (id: string, workspaceId: WorkspaceId = ws): Asset =>
  ({
    id,
    workspaceId,
    state: "active",
    mimeType: "image/png",
    width: 512,
    height: 512,
    checksum: id,
    license: "x",
    commercialUse: true,
    provenance: "operator_upload",
    objectKey: id,
  }) as Asset;
const pass = {
  productPresent: true,
  sameProductAsReference: true,
  counts: { shelves: 3 },
  inventedTextOrLogo: false,
  notes: "",
  peopleCount: 1,
  subjects: [{ kind: "face", box: [420, 120, 580, 300] }],
};

type Job = Omit<ClaimedJob, "leaseToken"> & { leaseToken: string; status: string; reason?: string };

const setup = (
  options: {
    cast?: unknown[];
    colour?: number;
    slides?: ContentItem["creativeSlides"];
    direction?: boolean;
    photos?: string[];
    measure?: boolean;
    /** Real-composite deps: the canonical mode the photo yields; compose calls are recorded. */
    composite?: "cutout" | "framed";
    /** Offer title override (the default is a count-critical estante). */
    title?: string;
    /** The composite step throws (bad cut-out bytes). */
    composeFails?: boolean;
  } = {},
) => {
  const composed: Array<{ floor: boolean; cutout: string }> = [];
  const jobs: Job[] = [];
  const enqueued: EnqueueJobInput[] = [];
  const enqueue = async (input: EnqueueJobInput) => {
    enqueued.push(input);
    if (!jobs.some((job) => job.idempotencyKey === input.idempotencyKey))
      jobs.push({
        id: randomUUID(),
        workspaceId: (input.payload as { workspaceId: WorkspaceId }).workspaceId,
        name: input.name,
        payload: input.payload,
        leaseToken: randomUUID(),
        idempotencyKey: input.idempotencyKey,
        attemptCount: 0,
        status: "pending",
      });
    return { id: "q" } as never;
  };
  const assets = new Map<string, Asset>([
    [SHEET, image(SHEET)],
    [PHOTO, image(PHOTO)],
    [PHOTO2, image(PHOTO2)],
    ...(options.composite === "cutout"
      ? ([
          [
            CUTOUT,
            {
              ...image(CUTOUT),
              metadata: { role: "canonical_product", mode: "cutout", sourceAssetId: PHOTO },
            },
          ],
        ] as const)
      : []),
  ]);
  let item = {
    id: itemId,
    workspaceId: ws,
    nicheId: "n1",
    offerId,
    offerSnapshotId: "s1",
    title: "Auto",
    sourceFactKeys: ["current_price"],
    sourcePictureAssetIds: options.photos ?? [PHOTO],
    creativeSlides: options.slides ?? slides,
    creativeOpinion: "o",
    state: "draft",
  } as unknown as ContentItem;
  let variants: ContentVariant[] = [
    { id: "v1", workspaceId: ws, contentItemId: itemId, channelId: "ig" } as ContentVariant,
  ];
  const stored: string[] = [];
  const finder = (workspaceId: WorkspaceId, id: string) => {
    const found = assets.get(id);
    return found && found.workspaceId === workspaceId ? found : null;
  };
  const patch = (id: string, next: Partial<Asset>) => {
    const found = assets.get(id);
    if (!found) return null;
    const updated = { ...found, ...next } as Asset;
    assets.set(id, updated);
    return updated;
  };
  const deps = {
    queue: {
      claim: async ({ names, workspaceId }: { names: readonly string[]; workspaceId: string }) => {
        const job = jobs.find(
          (j) => j.status === "pending" && names.includes(j.name) && j.workspaceId === workspaceId,
        );
        if (!job) return null;
        job.status = "running";
        return job;
      },
      takeLease: async ({ id, leaseToken }: { id: string; leaseToken: string }) => {
        const job = jobs.find((j) => j.id === id);
        if (job?.status !== "running" || job.leaseToken !== leaseToken) return null;
        job.leaseToken = randomUUID();
        return job;
      },
      complete: async ({ id }: { id: string }) => {
        const job = jobs.find((j) => j.id === id);
        if (job) job.status = "done";
      },
      retry: async ({ id, reason }: { id: string; reason: string }) => {
        const job = jobs.find((j) => j.id === id);
        // Like the queue's attempt policy: a third retry fails for good (no endless loop).
        if (job)
          Object.assign(job, {
            attemptCount: job.attemptCount + 1,
            status: job.attemptCount + 1 >= 3 ? "failed" : "pending",
            reason,
          });
      },
      failPermanently: async ({ id, reason }: { id: string; reason: string }) => {
        const job = jobs.find((j) => j.id === id);
        if (job) Object.assign(job, { status: "failed", reason });
      },
    },
    leaseDurationMs: 1,
    content: {
      findContentItemForWorkspace: async ({ workspaceId }: { workspaceId: string }) =>
        workspaceId === ws ? item : null,
    },
    niches: {
      findForWorkspace: async () => ({
        id: "n1",
        state: "active",
        context: {
          storyWorld: "small rented apartment, sage green and beige",
          characters: options.cast ?? [
            { name: "Bia", role: "secondary", description: "friend", referenceAssetIds: [PHOTO] },
            {
              name: "Carla",
              role: "main",
              description: "35, curly hair",
              referenceAssetIds: [SHEET],
            },
          ],
        },
      }),
    },
    reencodeImage: async (bytes: Uint8Array) => ({
      bytes,
      mimeType: "image/png",
      width: ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0),
      height: ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0),
    }),
    offerScenes: {
      offers: {
        findForWorkspace: async () => (options.title ? { ...offer, title: options.title } : offer),
      },
      content: {
        updateContentItem: async (next: ContentItem) => (item = next),
        listVariantsForWorkspace: async () => variants,
        updateVariant: async (next: ContentVariant) => {
          variants = variants.map((v) => (v.id === next.id ? next : v));
          return next;
        },
      },
      assets: {
        findForWorkspace: async ({
          workspaceId,
          assetId,
        }: {
          workspaceId: WorkspaceId;
          assetId: string;
        }) => finder(workspaceId, assetId),
        create: async (asset: Asset) => {
          assets.set(asset.id, asset);
          return asset;
        },
        updateState: async ({ assetId, state }: { assetId: string; state: Asset["state"] }) =>
          patch(assetId, { state }),
        updateRights: async ({
          assetId,
          commercialUse,
        }: {
          assetId: string;
          commercialUse: boolean | null;
        }) => patch(assetId, { commercialUse }),
        updateMetadata: async ({
          assetId,
          patch: p,
        }: {
          assetId: string;
          patch: Record<string, unknown>;
        }) => patch(assetId, { metadata: { ...assets.get(assetId)?.metadata, ...p } }),
        listByMetadata: async (q: {
          workspaceId: string;
          role: string;
          key: string;
          value: string;
          state?: string;
        }) =>
          [...assets.values()].filter(
            (a) =>
              a.workspaceId === q.workspaceId &&
              a.state === (q.state ?? "active") &&
              a.metadata?.role === q.role &&
              a.metadata?.[q.key] === q.value,
          ),
      },
      store: {
        createDownload: async ({ assetId }: { assetId: string }) => ({
          url: `https://r2/${assetId}`,
        }),
        putObject: async ({ assetId }: { assetId: string }) => void stored.push(assetId),
      },
      jobs: { enqueue },
      fetchBytes: async (url: string) => new TextEncoder().encode(url),
      productColours: async () => [[15, 15, 15] as const],
      colourEvidence: async () => [{ productShare: 0.6, scenePresence: options.colour ?? 0.05 }],
      ...(options.direction ? { direction: true } : {}),
      ...(options.composite
        ? {
            composite: {
              canonical: async () => ({
                assetId: CUTOUT,
                mode: options.composite,
                sourceAssetId: PHOTO,
                width: 10,
                height: 10,
              }),
              compose: async (scene: Uint8Array, cutout: Uint8Array, o: { floor: boolean }) => {
                if (options.composeFails) throw new Error("sharp: unsupported image");
                composed.push({ floor: o.floor, cutout: new TextDecoder().decode(cutout) });
                return new Uint8Array([...scene, 0xc0]);
              },
            },
          }
        : {}),
      // The second photo reads sharper than the first; the fake download URL names the asset.
      ...(options.measure === false
        ? {}
        : {
            referenceEvidence: async (bytes: Uint8Array) => ({
              sharpness: new TextDecoder().decode(bytes).endsWith(PHOTO2) ? 400 : 40,
              whiteBorderShare: 0.9,
              width: 1000,
              height: 1000,
            }),
          }),
    },
    now: () => new Date("2026-10-06T12:00:00Z"),
  } as unknown as HomeTaskDeps;
  const scenes = (state?: Asset["state"]) =>
    [...assets.values()].filter(
      (a) => a.metadata?.role === "offer_scene" && (state === undefined || a.state === state),
    );
  return {
    deps,
    jobs,
    enqueued,
    composed,
    enqueue,
    assets,
    scenes,
    stored,
    item: () => item,
    variants: () => variants,
  };
};
type Harness = ReturnType<typeof setup>;

const start = (h: Harness) =>
  h.enqueue({
    name: "generate_offer_scenes",
    payload: { version: 1, workspaceId: ws, identifiers: { contentItemId: itemId } },
    idempotencyKey: `offer-scenes:${itemId}:start`,
  } as EnqueueJobInput);

const editor = token(["image_editing"]);
const checker = token(["visual_qa"]);

/** Claims and answers every scene task with correctly sized images. */
const drawAll = async (h: Harness) => {
  for (;;) {
    const task = await claimHomeTask(h.deps, editor);
    if (!task || task.kind !== "generate_offer_scenes") return;
    const outcome = await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: task.scenes.map((scene) => ({
          key: scene.key,
          bytes: png(scene.size.width, scene.size.height),
          model: KLEIN,
          seed: scene.seed,
          provenance: { runtime: "stable-diffusion.cpp" },
        })),
      },
    });
    expect(outcome).toEqual({ ok: true });
  }
};
/** Answers every fidelity task; a function picks the answer per scene (its metadata). */
const checkAll = async (h: Harness, answer: unknown | ((scene: Asset) => unknown) = pass) => {
  for (;;) {
    const task = await claimHomeTask(h.deps, checker);
    if (!task || task.kind !== "check_scene_fidelity") return;
    const scene = h.assets.get(task.sceneUrl.replace("https://r2/", ""));
    if (!scene) throw new Error("scene asset missing");
    // A listing photo check (mode reference) is answered "clean" unless the test says otherwise.
    const clean = { cleanProduct: true, extras: [], note: "" };
    await applyHomeResult(h.deps, checker, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "check_scene_fidelity",
        answer:
          typeof answer === "function" ? answer(scene) : task.mode === "reference" ? clean : answer,
        model: VLM,
      },
    });
  }
};

const drawOnce = async (h: Harness) => {
  const task = await claimHomeTask(h.deps, editor);
  if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
  await applyHomeResult(h.deps, editor, {
    jobId: task.jobId,
    leaseToken: task.leaseToken,
    result: {
      kind: "generate_offer_scenes",
      scenes: task.scenes.map((scene) => ({
        key: scene.key,
        bytes: png(scene.size.width, scene.size.height),
        model: KLEIN,
        seed: scene.seed,
      })),
    },
  });
  return (key: string) => task.scenes.find((s) => s.key === key)?.prompt ?? "";
};
const isCutout = (scene: Asset) => scene.metadata?.role === "canonical_product";

describe("generate_offer_scenes home task (D1)", () => {
  it("is claimable only with image_editing, in the token's workspace", async () => {
    const h = setup();
    await start(h);
    expect(await claimHomeTask(h.deps, token(["visual_qa", "copywriting"]))).toBeNull();
    expect(await claimHomeTask(h.deps, token(["image_editing"], otherWs))).toBeNull();
  });

  it("builds up to three scenes from [character sheet, product photo] with no price", async () => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    expect(task?.kind).toBe("generate_offer_scenes");
    if (task?.kind !== "generate_offer_scenes") return;
    expect(task.referenceUrls).toEqual([`https://r2/${SHEET}`, `https://r2/${PHOTO}`]);
    expect(task.scenes.map((s) => [s.key, s.size])).toEqual([
      ["1:feed", { width: 512, height: 640 }],
      ["2:feed", { width: 512, height: 640 }],
      ["3:feed", { width: 512, height: 640 }],
    ]);
    const first = task.scenes[0]?.prompt ?? "";
    expect(first).toContain("Carla: 35, curly hair");
    expect(first).toContain("main colours black");
    expect(first).toContain("with exactly 3 shelves");
    expect(first).not.toMatch(/R\$|89/);
  });

  it("stores pending scenes with provenance, queues their checks and the next batch once", async () => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const result: HomeResult = {
      kind: "generate_offer_scenes",
      scenes: task.scenes.map((s) => ({
        key: s.key,
        bytes: png(512, 640),
        model: KLEIN,
        seed: s.seed,
      })),
    };
    expect(
      await applyHomeResult(h.deps, editor, {
        jobId: task.jobId,
        leaseToken: task.leaseToken,
        result,
      }),
    ).toEqual({ ok: true });
    expect(h.scenes("pending")).toHaveLength(3);
    expect(h.scenes()[0]).toMatchObject({
      commercialUse: null,
      creator: KLEIN,
      metadata: {
        role: "offer_scene",
        contentItemId: itemId,
        slideIndex: 1,
        canvas: "feed",
        attempt: 1,
        model: KLEIN,
        referenceAssetIds: [SHEET, PHOTO],
        homeWorker: { status: "pending_fidelity", jobId: task.jobId },
      },
    });
    // Three scene checks plus the listing photo's own reference check (brief 11.1).
    // `jobs` is the deduplicated queue; `enqueued` records every call (one per compile).
    const checks = h.jobs.filter((j) => j.name === "check_scene_fidelity");
    const assetOf = (j: Pick<EnqueueJobInput, "payload">) =>
      (j.payload as { identifiers: Record<string, string> }).identifiers.assetId;
    expect(checks.filter((j) => assetOf(j) !== PHOTO)).toHaveLength(3);
    expect(checks.filter((j) => assetOf(j) === PHOTO)).toHaveLength(1);
    expect(h.jobs.map((j) => j.idempotencyKey)).toContain(`offer-scenes:${itemId}:1:story@1`);
    // A second post is not leased and writes nothing.
    expect(
      await applyHomeResult(h.deps, editor, {
        jobId: task.jobId,
        leaseToken: task.leaseToken,
        result,
      }),
    ).toEqual({ ok: false, reason: "task_not_leased" });
    expect(h.scenes()).toHaveLength(3);
  });

  it("stores a posted depth map as a scene_depth asset linked from its scene; drops a wrong size", async () => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const [first, second] = task.scenes;
    const outcome = await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: [
          {
            key: first!.key,
            bytes: png(512, 640),
            model: KLEIN,
            seed: first!.seed,
            depth: png(512, 640),
          },
          {
            key: second!.key,
            bytes: png(512, 640),
            model: KLEIN,
            seed: second!.seed,
            depth: png(64, 64),
          },
        ],
      },
    });
    expect(outcome).toEqual({ ok: true });
    const depths = [...h.assets.values()].filter((a) => a.metadata?.role === "scene_depth");
    expect(depths).toHaveLength(1);
    expect(depths[0]).toMatchObject({
      provenance: "generated",
      creator: DEPTH_MODEL,
      metadata: { contentItemId: itemId, slideIndex: 1 },
    });
    const [withDepth, withoutDepth] = h.scenes();
    expect(withDepth?.metadata?.depthAssetId).toBe(depths[0]?.id);
    expect(withoutDepth?.metadata).not.toHaveProperty("depthAssetId");
  });

  it("accepts a scene upscaled exactly x2 and records the upscale", async () => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const scene = task.scenes[0];
    const outcome = await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: [{ key: scene!.key, bytes: png(1024, 1280), model: KLEIN, seed: scene!.seed }],
      },
    });
    expect(outcome).toEqual({ ok: true });
    expect(h.scenes()[0]).toMatchObject({
      width: 1024,
      height: 1280,
      metadata: { upscale: "realesr-animevideov3-x2" },
    });
  });

  it.each([
    [
      "an image model outside image_editing",
      { model: "local:z-image-turbo" },
      "scene_model_not_allowlisted",
    ],
    ["a wrong canvas size", { bytes: png(512, 512) }, "scene_size_mismatch"],
    ["an upscale that is not exactly x2", { bytes: png(1024, 1024) }, "scene_size_mismatch"],
    ["another seed", { seed: 7 }, "scene_seed_mismatch"],
    ["an unknown slot", { key: "9:feed" }, "scene_key_unknown"],
  ])("refuses %s and writes nothing", async (_name, over, reason) => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const scene = task.scenes[0];
    const outcome = await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: [
          { key: scene!.key, bytes: png(512, 640), model: KLEIN, seed: scene!.seed, ...over },
        ],
      },
    });
    expect(outcome).toEqual({ ok: false, reason });
    expect(h.scenes()).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it("queues a reference check per listing photo; a photo the VLM called not clean is not picked and lends no colours", async () => {
    const h = setup({ photos: [PHOTO, PHOTO2] });
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const checksFor = (id: string) =>
      h.jobs.filter(
        (job) =>
          job.name === "check_scene_fidelity" &&
          (job.payload as { identifiers: Record<string, string> }).identifiers.assetId === id,
      );
    expect(checksFor(PHOTO)).toHaveLength(1);
    expect(checksFor(PHOTO2)).toHaveLength(1);
    expect(checksFor(PHOTO)[0]).toMatchObject({
      payload: { identifiers: { contentItemId: itemId } },
    });
    // The sharper photo (PHOTO2) is a styled scene; the first one is clean.
    await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: task.scenes.map((scene) => ({
          key: scene.key,
          bytes: png(scene.size.width, scene.size.height),
          model: KLEIN,
          seed: scene.seed,
        })),
      },
    });
    await drawAll(h);
    await checkAll(h, (scene: Asset) =>
      scene.id === PHOTO
        ? { cleanProduct: true, extras: [], note: "" }
        : scene.id === PHOTO2
          ? { cleanProduct: false, extras: ["props", "text_or_badges"], note: "kitchen" }
          : { ...pass, counts: { shelves: 4 } },
    );
    expect(h.assets.get(PHOTO)?.metadata?.referenceCheck).toMatchObject({ clean: true });
    expect(h.assets.get(PHOTO2)?.metadata?.referenceCheck).toMatchObject({
      clean: false,
      extras: ["props", "text_or_badges"],
    });
    // Redraw round: the clean photo wins over the sharper one; no new checks are queued.
    const next = await claimHomeTask(h.deps, editor);
    if (next?.kind !== "generate_offer_scenes") throw new Error("no redraw task");
    expect(next.referenceUrls[1]).toBe(`https://r2/${PHOTO}`);
    expect(next.scenes[0]?.prompt).toContain("main colours black");
    expect(checksFor(PHOTO)).toHaveLength(1);
  });

  it("states no colours when the only listing photo is not clean", async () => {
    const h = setup();
    await start(h);
    await drawOnce(h);
    await drawAll(h);
    await checkAll(h, (scene: Asset) =>
      scene.id === PHOTO
        ? { cleanProduct: false, extras: ["inset_photos"], note: "" }
        : { ...pass, counts: { shelves: 4 } },
    );
    const next = await claimHomeTask(h.deps, editor);
    if (next?.kind !== "generate_offer_scenes") throw new Error("no redraw task");
    expect(next.referenceUrls[1]).toBe(`https://r2/${PHOTO}`);
    expect(next.scenes[0]?.prompt).not.toContain("main colours");
  });

  it("draws from the sharpest clean listing photo, not the first one", async () => {
    const h = setup({ photos: [PHOTO, PHOTO2] });
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    expect(task.referenceUrls).toEqual([`https://r2/${SHEET}`, `https://r2/${PHOTO2}`]);
    const plain = setup({ photos: [PHOTO, PHOTO2], measure: false });
    await start(plain);
    const first = await claimHomeTask(plain.deps, editor);
    if (first?.kind !== "generate_offer_scenes") throw new Error("no task");
    expect(first.referenceUrls[1]).toBe(`https://r2/${PHOTO}`);
  });

  it("falls back to the cut-out render when the niche has no main character sheet", async () => {
    const h = setup({ cast: [{ name: "X", description: "y" }] });
    await start(h);
    expect(await claimHomeTask(h.deps, editor)).toBeNull();
    expect(h.enqueued.at(-1)).toMatchObject({ name: "render_creatives" });
    expect(h.variants()[0]?.creativeRender).toMatchObject({
      state: "pending",
      reason: "in_scene_fallback:main_character_sheet_missing",
    });
  });
});

describe("check_scene_fidelity home task (D2)", () => {
  it("sends the scene, the product photo and the visual spec; never to an editor token", async () => {
    const h = setup();
    await start(h);
    await drawAll(h);
    expect(await claimHomeTask(h.deps, editor)).toBeNull();
    const task = await claimHomeTask(h.deps, checker);
    expect(task).toMatchObject({
      kind: "check_scene_fidelity",
      referenceUrl: `https://r2/${PHOTO}`,
      spec: { features: [{ key: "shelves", value: 3 }] },
    });
  });

  it("passes every scene, grants rights, pins the scenes on the slides and renders once", async () => {
    const h = setup();
    await start(h);
    await drawAll(h);
    await checkAll(h);
    await drawAll(h);
    await checkAll(h);
    const active = h.scenes("active");
    expect(active).toHaveLength(4);
    expect(active[0]).toMatchObject({
      commercialUse: true,
      metadata: {
        inSceneFidelity: {
          verdict: "pass",
          reasons: [],
          model: VLM,
          colour: [{ productShare: 0.6 }],
          vlm: { subjects: [{ kind: "face", box: [420, 120, 580, 300] }] },
        },
        homeWorker: { status: "approved", reviewedBy: "automatic_fidelity_gate" },
      },
    });
    const slidesNow = h.item().creativeSlides ?? [];
    expect(slidesNow.every((slide) => slide.sceneAssetId)).toBe(true);
    expect(slidesNow[0]?.storySceneAssetId).toBeDefined();
    expect(h.enqueued.filter((j) => j.name === "render_creatives")).toHaveLength(1);
  });

  it("archives a blocked scene and redraws it with a new seed, then falls back after the last attempt", async () => {
    const h = setup({ colour: 0 });
    await start(h);
    for (let attempt = 1; attempt <= MAX_OFFER_SCENE_ATTEMPTS; attempt += 1) {
      await drawAll(h);
      await checkAll(h);
    }
    const archived = h.scenes("archived");
    expect(archived.length).toBeGreaterThanOrEqual(MAX_OFFER_SCENE_ATTEMPTS);
    expect(archived[0]?.metadata?.inSceneFidelity).toMatchObject({
      verdict: "block",
      reasons: ["colour_mismatch"],
    });
    expect(new Set(archived.map((a) => a.metadata?.seed)).size).toBe(archived.length);
    expect(h.scenes("active")).toHaveLength(0);
    expect(h.jobs.filter((j) => j.name === "render_creatives")).toHaveLength(1);
    expect(h.variants()[0]?.creativeRender?.reason).toMatch(/^in_scene_fallback:.*colour_mismatch/);
    expect(h.item().creativeSlides?.some((slide) => slide.sceneAssetId)).toBe(false);
    expect(await claimHomeTask(h.deps, editor)).toBeNull();
  });

  it("blocks a scene with more people than the plan allows (one, undirected)", async () => {
    const h = setup();
    await start(h);
    await drawAll(h);
    await checkAll(h, { ...pass, peopleCount: 2 });
    const archived = h.scenes("archived");
    expect(archived.length).toBeGreaterThan(0);
    expect(archived[0]?.metadata).toMatchObject({ expectedPeople: 1 });
    expect(archived[0]?.metadata?.inSceneFidelity).toMatchObject({
      verdict: "block",
      reasons: ["extra_person"],
    });
    expect(h.scenes("active")).toHaveLength(0);
    await checkAll(h, { ...pass, peopleCount: 1 });
    expect(h.scenes("active")).toHaveLength(0);
  });

  it("keeps the approved scenes and renders only the exhausted slot cut-out", async () => {
    const h = setup();
    await start(h);
    const coverFeed = (scene: Asset) =>
      scene.metadata?.slideIndex === 1 && scene.metadata?.canvas === "feed";
    for (let attempt = 1; attempt <= MAX_OFFER_SCENE_ATTEMPTS; attempt += 1) {
      await drawAll(h);
      await checkAll(h, (scene: Asset) =>
        coverFeed(scene) ? { ...pass, productPresent: false } : pass,
      );
    }
    expect(h.scenes("archived")).toHaveLength(MAX_OFFER_SCENE_ATTEMPTS);
    expect(h.scenes("active")).toHaveLength(3);
    const slidesNow = h.item().creativeSlides ?? [];
    expect(slidesNow[0]?.sceneAssetId).toBeUndefined();
    expect(slidesNow[0]?.storySceneAssetId).toBeDefined();
    expect(slidesNow[1]?.sceneAssetId).toBeDefined();
    expect(slidesNow[2]?.sceneAssetId).toBeDefined();
    expect(h.jobs.filter((j) => j.name === "render_creatives")).toHaveLength(1);
    expect(h.variants()[0]?.creativeRender?.reason).toMatch(
      /^in_scene_partial:attempts_exhausted:1:feed:product_absent/,
    );
    expect(await claimHomeTask(h.deps, editor)).toBeNull();
  });

  it("directs product-only shots without the character and blocks a drawn person", async () => {
    const directed = slides.map((slide, i) => ({
      ...slide,
      template: (["hero", "benefit", "price"] as const)[i] ?? ("price" as const),
      ...(i === 0
        ? { sceneLine: "Carla sliding the rack under the sink.", sceneLineSource: "model" as const }
        : {}),
    }));
    const h = setup({ slides: directed, direction: true });
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const prompt = (key: string) => task.scenes.find((s) => s.key === key)?.prompt ?? "";
    expect(prompt("1:feed")).toContain(
      "Carla sliding the rack under the sink. Exactly one person, Carla",
    );
    // The title states a count (3 shelves): after the hero every slot is product-only (shotFor).
    expect(prompt("2:feed")).toContain("No people, no hands");
    expect(prompt("2:feed")).not.toContain("Carla's hands");
    expect(prompt("3:feed")).toContain("No people, no hands");
    expect(prompt("3:feed")).not.toContain("Carla");
    await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: task.scenes.map((scene) => ({
          key: scene.key,
          bytes: png(scene.size.width, scene.size.height),
          model: KLEIN,
          seed: scene.seed,
        })),
      },
    });
    await drawAll(h);
    await checkAll(h, { ...pass, peopleCount: 1 });
    const hero = h.scenes().find((s) => s.metadata?.slideIndex === 3);
    expect(hero?.metadata).toMatchObject({ expectedPeople: 0 });
    expect(hero?.state).toBe("archived");
    expect(hero?.metadata?.inSceneFidelity).toMatchObject({ reasons: ["extra_person"] });
    expect(h.scenes().find((s) => s.metadata?.slideIndex === 2)?.state).toBe("archived");
    expect(h.scenes("active")).toHaveLength(2);
  });

  it("checks the cut-out first, then composites it on drawn backdrops for the product-only slots", async () => {
    const directed = slides.map((slide, i) => ({
      ...slide,
      template: (["hero", "benefit", "price"] as const)[i] ?? ("price" as const),
    }));
    const h = setup({ slides: directed, direction: true, composite: "cutout" });
    await start(h);
    // Round 1: the cut-out verdict is not in yet, so the product is drawn and its check queued.
    const first = await drawOnce(h);
    expect(first("2:feed")).not.toContain("Do not draw the product");
    expect(
      h.enqueued.find(
        (job) =>
          job.name === "check_scene_fidelity" &&
          (job.payload as { identifiers: Record<string, string> }).identifiers.assetId === CUTOUT,
      ),
    ).toMatchObject({ payload: { identifiers: { contentItemId: itemId } } });
    await drawAll(h);
    expect(h.composed).toEqual([]);
    // The cut-out counts 3 shelves (clean); the drawn product-only scenes count 4 (blocked).
    await checkAll(h, (scene: Asset) =>
      isCutout(scene)
        ? { ...pass, peopleCount: 0 }
        : {
            ...pass,
            peopleCount: scene.metadata?.expectedPeople === 0 ? 0 : 1,
            counts: { shelves: scene.metadata?.expectedPeople === 0 ? 4 : 3 },
          },
    );
    expect(h.assets.get(CUTOUT)?.metadata?.cutoutCheck).toMatchObject({
      verdict: "pass",
      counts: { shelves: 3 },
    });
    // Round 2: backdrops only, with the real cut-out composited on the floor line.
    const second = await drawOnce(h);
    expect(second("2:feed")).toContain("Do not draw the product from the second reference image");
    expect(second("2:feed")).toContain("No people, no hands");
    expect(h.composed).toEqual([
      { floor: true, cutout: `https://r2/${CUTOUT}` },
      { floor: true, cutout: `https://r2/${CUTOUT}` },
    ]);
    const composite = h
      .scenes()
      .find((s) => s.metadata?.slideIndex === 2 && s.metadata?.attempt === 2);
    expect(composite?.metadata).toMatchObject({
      productMode: "composite",
      canonicalAssetId: CUTOUT,
    });
    expect(h.scenes().find((s) => s.metadata?.slideIndex === 1)?.metadata?.productMode).toBe(
      undefined,
    );
    await checkAll(h, { ...pass, peopleCount: 0 });
    // Three feed slides plus the story cover.
    expect(h.scenes("active")).toHaveLength(4);
  });

  it("repairs a product-only slot that drew the wrong product with the real cut-out", async () => {
    const directed = slides.map((slide, i) => ({
      ...slide,
      template: (["hero", "benefit", "price"] as const)[i] ?? ("price" as const),
    }));
    const h = setup({
      slides: directed,
      direction: true,
      composite: "cutout",
      title: "Organizador Acrílico Transparente",
    });
    const cutoutChecks = () =>
      h.jobs.filter(
        (job) =>
          (job.payload as { identifiers: Record<string, string> }).identifiers.assetId === CUTOUT,
      ).length;
    // The product-only price shot draws the wrong product; the character shots pass.
    const answer = (scene: Asset) =>
      isCutout(scene)
        ? { ...pass, peopleCount: 0, counts: {} }
        : scene.metadata?.expectedPeople === 0
          ? { ...pass, peopleCount: 0, counts: {}, sameProductAsReference: false }
          : { ...pass, counts: {} };
    await start(h);
    await drawAll(h);
    // Not count-critical and nothing failed yet: no cut-out, no cut-out check.
    expect(cutoutChecks()).toBe(0);
    await checkAll(h, answer);
    // Attempt 2: the failure queues the cut-out check; the product is drawn once more.
    const second = await drawOnce(h);
    expect(second("3:feed")).not.toContain("Do not draw the product");
    expect(cutoutChecks()).toBe(1);
    await checkAll(h, answer);
    // Attempt 3: same scene plan, backdrop only, the real cut-out composited (counter height).
    const third = await drawOnce(h);
    expect(third("3:feed")).toContain("Do not draw the product from the second reference image");
    expect(h.composed).toEqual([{ floor: false, cutout: `https://r2/${CUTOUT}` }]);
    await checkAll(h, { ...pass, peopleCount: 0, counts: {} });
    expect(h.scenes("active")).toHaveLength(4);
  });

  it("never strands the package when compositing fails: the slot goes back to drawing", async () => {
    const directed = slides.map((slide, i) => ({
      ...slide,
      template: (["hero", "benefit", "price"] as const)[i] ?? ("price" as const),
    }));
    const h = setup({ slides: directed, direction: true, composite: "cutout", composeFails: true });
    const cutout = h.assets.get(CUTOUT);
    if (cutout)
      h.assets.set(CUTOUT, {
        ...cutout,
        metadata: { ...cutout.metadata, cutoutCheck: { verdict: "pass" } },
      });
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    expect(task.scenes.find((s) => s.key === "2:feed")?.prompt).toContain(
      "Do not draw the product",
    );
    const outcome = await applyHomeResult(h.deps, editor, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: {
        kind: "generate_offer_scenes",
        scenes: task.scenes.map((scene) => ({
          key: scene.key,
          bytes: png(scene.size.width, scene.size.height),
          model: KLEIN,
          seed: scene.seed,
        })),
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "scene_composite_failed" });
    expect(h.scenes()).toHaveLength(0);
    expect(h.assets.get(CUTOUT)?.metadata?.cutoutCheck).toMatchObject({
      verdict: "block",
      reasons: ["composite_failed"],
    });
    // The job is back in the queue; its next claim draws the product again.
    const again = await claimHomeTask(h.deps, editor);
    if (again?.kind !== "generate_offer_scenes") throw new Error("no retry task");
    expect(again.scenes.find((s) => s.key === "2:feed")?.prompt).not.toContain(
      "Do not draw the product",
    );
  });

  it("redraws a scene drawn from a prompt that changed before apply, stores nothing", async () => {
    const h = setup();
    await start(h);
    const task = await claimHomeTask(h.deps, editor);
    if (task?.kind !== "generate_offer_scenes") throw new Error("no task");
    const reply = (promptSha256: (prompt: string) => string) =>
      applyHomeResult(h.deps, editor, {
        jobId: task.jobId,
        leaseToken: task.leaseToken,
        result: {
          kind: "generate_offer_scenes",
          scenes: task.scenes.map((scene) => ({
            key: scene.key,
            bytes: png(scene.size.width, scene.size.height),
            model: KLEIN,
            seed: scene.seed,
            promptSha256: promptSha256(scene.prompt),
          })),
        },
      });
    expect(await reply(() => "0".repeat(64))).toEqual({ ok: false, reason: "scene_round_changed" });
    expect(h.scenes()).toHaveLength(0);
  });

  it("keeps drawing the product when the cut-out is a collage (count mismatch)", async () => {
    const h = setup({ slides, direction: true, composite: "cutout" });
    await start(h);
    await drawOnce(h);
    await drawAll(h);
    await checkAll(h, (scene: Asset) =>
      isCutout(scene)
        ? { ...pass, peopleCount: 0, counts: { shelves: 4 } }
        : { ...pass, counts: { shelves: 4 } },
    );
    expect(h.assets.get(CUTOUT)?.metadata?.cutoutCheck).toMatchObject({
      verdict: "block",
      reasons: ["count_mismatch:shelves"],
    });
    const second = await drawOnce(h);
    expect(second("2:feed")).not.toContain("Do not draw the product");
    expect(h.composed).toEqual([]);
  });

  it("draws the product as before when the photo yields no clean cut-out", async () => {
    const h = setup({ slides, direction: true, composite: "framed" });
    await start(h);
    const prompt = await drawOnce(h);
    expect(prompt("2:feed")).not.toContain("Do not draw the product");
    expect(
      h.enqueued.some(
        (job) =>
          (job.payload as { identifiers: Record<string, string> }).identifiers.assetId === CUTOUT,
      ),
    ).toBe(false);
    expect(h.composed).toEqual([]);
    expect(h.scenes()).toHaveLength(3);
  });

  it.each([
    ["a malformed answer", { productPresent: true }],
    ["a missing answer", undefined],
  ])("retries %s and never passes", async (_name, answer) => {
    const h = setup();
    await start(h);
    await drawAll(h);
    const task = await claimHomeTask(h.deps, checker);
    if (task?.kind !== "check_scene_fidelity") throw new Error("no task");
    const outcome = await applyHomeResult(h.deps, checker, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: { kind: "check_scene_fidelity", answer, model: VLM },
    });
    expect(outcome).toEqual({ ok: false, reason: "fidelity_answer_invalid" });
    expect(h.jobs.find((j) => j.id === task.jobId)).toMatchObject({ status: "pending" });
    expect(h.scenes("active")).toHaveLength(0);
  });

  it("refuses a model outside visual_qa", async () => {
    const h = setup();
    await start(h);
    await drawAll(h);
    const task = await claimHomeTask(h.deps, checker);
    if (task?.kind !== "check_scene_fidelity") throw new Error("no task");
    const outcome = await applyHomeResult(h.deps, checker, {
      jobId: task.jobId,
      leaseToken: task.leaseToken,
      result: { kind: "check_scene_fidelity", answer: pass, model: KLEIN },
    });
    expect(outcome).toEqual({ ok: false, reason: "fidelity_model_not_allowlisted" });
  });

  it("never reads a scene of another workspace", async () => {
    const h = setup();
    const foreign = {
      ...image("cccccccc-cccc-4ccc-8ccc-cccccccccccc", otherWs),
      state: "pending",
      metadata: {
        role: "offer_scene",
        contentItemId: itemId,
        slideIndex: 1,
        canvas: "feed",
        attempt: 1,
      },
    } as Asset;
    h.assets.set(foreign.id, foreign);
    await h.enqueue({
      name: "check_scene_fidelity",
      payload: { version: 1, workspaceId: ws, identifiers: { assetId: foreign.id } },
      idempotencyKey: `scene-fidelity:${foreign.id}`,
    } as EnqueueJobInput);
    expect(await claimHomeTask(h.deps, checker)).toBeNull();
    expect(h.jobs[0]).toMatchObject({ status: "failed", reason: "offer_scene_not_found" });
  });
});

describe("reviewer rejects one scene (Review Studio)", () => {
  const rejectDeps = (h: Harness) => {
    const scenes = (
      h.deps as unknown as {
        offerScenes: {
          content: { listVariantsForWorkspace: never; updateVariant: never };
          assets: never;
          jobs: never;
        };
      }
    ).offerScenes;
    return {
      content: {
        findContentItemForWorkspace: async () => h.item(),
        findVariantForWorkspace: async ({ variantId }: { variantId: string }) =>
          h.variants().find((variant) => variant.id === variantId) ?? null,
        listVariantsForWorkspace: scenes.content.listVariantsForWorkspace,
        updateVariant: scenes.content.updateVariant,
      },
      assets: scenes.assets,
      jobs: scenes.jobs,
      now: () => new Date("2026-10-09T12:00:00Z"),
    };
  };
  const renderedPackage = async (state: ContentVariant["state"]) => {
    const h = setup();
    await start(h);
    await drawAll(h);
    await checkAll(h);
    expect(h.scenes("active")).toHaveLength(4);
    const update = rejectDeps(h).content.updateVariant as (v: ContentVariant) => Promise<unknown>;
    for (const variant of h.variants())
      await update({
        ...variant,
        state,
        creativeRender: {
          state: "rendered",
          templateVersions: {},
          rendererVersion: 1,
          brandKitHash: "x",
        },
      });
    return h;
  };
  const input = {
    workspaceId: ws,
    contentItemId: itemId,
    slideIndex: 2,
    canvas: "feed" as const,
    reasons: ["BAD_PRODUCT" as const],
    note: "cor errada",
    actorId: "u" as UserId,
  };

  it("archives that scene, sends the package back to draft and redraws only its slot", async () => {
    const h = await renderedPackage("ready_for_review");
    const renders = () => h.jobs.filter((job) => job.name === "render_creatives").length;
    const rendersBefore = renders();
    const old = h.item().creativeSlides?.find((slide) => slide.index === 2)?.sceneAssetId;
    const out = await rejectOfferScene(rejectDeps(h), input);
    expect(out).toEqual({ ok: true, sceneAssetId: old, attempt: 2 });
    expect(h.assets.get(old ?? "")).toMatchObject({
      state: "archived",
      metadata: {
        ownerRejection: {
          reasons: ["product_differs_from_reference", "owner_rejected:BAD_PRODUCT"],
          note: "cor errada",
        },
      },
    });
    expect(
      h.variants().every((v) => v.state === "draft" && v.creativeRender?.state === "pending"),
    ).toBe(true);
    const prompt = await drawOnce(h);
    expect(prompt("2:feed")).not.toBe("");
    expect(prompt("1:feed")).toBe("");
    await checkAll(h);
    const next = h.item().creativeSlides?.find((slide) => slide.index === 2)?.sceneAssetId;
    expect(next).toBeDefined();
    expect(next).not.toBe(old);
    expect(h.scenes("active")).toHaveLength(4);
    // The re-render is a new job: the queue keeps keys forever, so a fixed key would be a no-op.
    expect(renders()).toBe(rendersBefore + 1);
  });

  it("allows two reviewer rejections per slot, then refuses", async () => {
    const h = await renderedPackage("ready_for_review");
    for (let round = 0; round < 2; round += 1) {
      expect(await rejectOfferScene(rejectDeps(h), input)).toMatchObject({ ok: true });
      await drawOnce(h);
      await checkAll(h);
    }
    expect(await rejectOfferScene(rejectDeps(h), input)).toEqual({
      ok: false,
      code: "attempt_budget_spent",
    });
  });

  it("never reworks approved content and needs a scene on that slide", async () => {
    const h = await renderedPackage("approved");
    expect(await rejectOfferScene(rejectDeps(h), input)).toEqual({
      ok: false,
      code: "variant_locked",
    });
    expect(
      await rejectOfferScene(rejectDeps(h), { ...input, slideIndex: 2, canvas: "story" }),
    ).toEqual({
      ok: false,
      code: "no_scene",
    });
  });
});
