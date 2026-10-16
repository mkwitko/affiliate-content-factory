import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { Channel } from "../channels/channel.js";
import type { ContentItem, ContentVariant } from "../content/content.js";
import { uuidFromKey } from "../content/offer-package.js";
import type { ClaimedJob } from "../jobs/job.js";
import type { Offer } from "../offers/offer.js";
import { applyHomeResult, claimHomeTask, type HomeResult, type HomeTaskDeps } from "./tasks.js";
import type { HomeWorkerToken } from "./tokens.js";

const ws = parseWorkspaceId("11111111-1111-4111-8111-111111111111");
const itemId = "33333333-3333-4333-8333-333333333333";
const model = "local:qwen3.5-9b";
const token = (capabilities: HomeWorkerToken["capabilities"]): HomeWorkerToken => ({
  id: "tok",
  workspaceId: ws,
  name: "n",
  tokenHash: "h",
  prefix: "mmhw_a",
  capabilities,
  createdById: "u",
  createdAt: new Date(),
  lastUsedAt: null,
  revokedAt: null,
});
const offer = {
  id: "44444444-4444-4444-8444-444444444444",
  workspaceId: ws,
  marketplace: "mercado_livre",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
  affiliateUrl: "https://meli.la/secret",
  title: "Cesto",
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [
    {
      id: "s1",
      verifiedAt: new Date(),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 10000, currency: "BRL" },
          sourceUrl: "https://www.mercadolivre.com.br/p/MLB1",
          verified: true,
        },
      ],
    },
  ],
} as unknown as Offer;
const channel = (id: string, kind: string, status = "active", nicheId: string | null = "n1") =>
  ({
    id,
    workspaceId: ws,
    nicheId,
    kind,
    status,
    capabilities: { captionMaxLength: 2200 },
  }) as unknown as Channel;
const slides = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1,
  total: 6,
  template: i === 0 ? ("hero" as const) : ("benefit" as const),
  headline: i === 0 ? "R$ 100 no cesto" : `Motivo ${i + 1}`,
  claims: i === 0 ? [{ text: "R$ 100", factKey: "current_price" }] : [],
}));
const result = (over: Record<string, unknown> = {}): HomeResult =>
  ({
    kind: "draft_offer_copy",
    model,
    draft: {
      slides,
      captions: { instagram_carousel: "Cesto por R$ 100", threads: "Cesto por R$ 100" },
    },
    ...over,
  }) as HomeResult;

const setup = (
  channels: Channel[] = [channel("ig", "instagram_carousel"), channel("th", "threads")],
  options: { auto?: boolean; offerScenes?: boolean; cast?: boolean } = {},
) => {
  let item = {
    id: options.auto ? uuidFromKey(`auto-sale:${offer.id}`) : itemId,
    workspaceId: ws,
    nicheId: "n1",
    offerId: offer.id,
    offerSnapshotId: "s1",
    title: "t",
    sourceFactKeys: ["current_price"],
    creativeOpinion: "o",
    state: "draft",
  } as unknown as ContentItem;
  const job = {
    id: "job-1",
    workspaceId: ws,
    name: "draft_offer_copy",
    payload: { version: 1, workspaceId: ws, identifiers: { contentItemId: itemId } },
    leaseToken: "lease",
    idempotencyKey: "offer-copy:x",
    attemptCount: 1,
  } as unknown as ClaimedJob;
  const state = { status: "pending", reason: "" };
  const variants: ContentVariant[] = [];
  const enqueue = vi.fn(async () => ({ id: "render-job" }));
  const readBuyerVoice = vi.fn(async () => ({
    positiveReviews: [{ rating: 5, title: "", text: "ótimo" }],
    negativeReviews: [],
    questions: [],
    pictures: [{ url: "https://img/photo.jpg", width: 1, height: 1, position: 0 }],
  }));
  const deps = {
    queue: {
      claim: async ({ names }: { names: readonly string[] }) => {
        if (state.status !== "pending" || !names.includes(job.name)) return null;
        state.status = "running";
        return job;
      },
      takeLease: async () => {
        if (state.status !== "running") return null;
        state.status = "leased";
        return { ...job, leaseToken: randomUUID() };
      },
      complete: async () => {
        state.status = "done";
      },
      retry: async ({ reason }: { reason: string }) => {
        Object.assign(state, { status: "retry", reason });
      },
      failPermanently: async ({ reason }: { reason: string }) => {
        Object.assign(state, { status: "failed", reason });
      },
    },
    leaseDurationMs: 1,
    content: { findContentItemForWorkspace: async () => item },
    niches: {
      findForWorkspace: async () => ({
        id: "n1",
        name: "Casa",
        editorialVoice: "v",
        languages: ["pt-BR"],
        state: "active",
        ...(options.cast
          ? {
              context: {
                storyWorld: "Scene: small rented apartment, late afternoon light.",
                characters: [
                  { name: "Carla", role: "main", description: "35, curly hair" },
                  { name: "Bia", role: "secondary", description: "friend" },
                ],
              },
            }
          : {}),
      }),
    },
    offerCopy: {
      offers: { findForWorkspace: async () => offer },
      channels: { listForWorkspace: async () => channels },
      catalogForWorkspace: () => ({ readBuyerVoice }),
      build: {
        contentRepository: {
          findContentItemForWorkspace: async () => item,
          updateContentItem: async (next: ContentItem) => (item = next),
          createVariant: async (v: ContentVariant) => (variants.push(v), v),
          listVariantsForWorkspace: async () => variants,
        },
        offerRepository: { findForWorkspace: async () => offer },
        channelRepository: {
          findForWorkspace: async ({ channelId }: { channelId: string }) =>
            channels.find((c) => c.id === channelId) ?? null,
        },
        jobQueue: { enqueue },
      },
    },
    ...(options.offerScenes ? { offerScenes: {} } : {}),
    now: () => new Date(),
  } as unknown as HomeTaskDeps;
  const storeSlides = () => {
    item = { ...item, creativeSlides: slides } as ContentItem;
  };
  return { deps, state, variants, enqueue, readBuyerVoice, storeSlides, item: () => item };
};

describe("draft_offer_copy home task", () => {
  it("is not claimable without the copywriting capability", async () => {
    const { deps } = setup();
    expect(
      await claimHomeTask(deps, token(["scene_director", "image_generation", "visual_qa"])),
    ).toBeNull();
  });

  it("builds a closed task: no photo URL, no affiliate URL, untrusted voice", async () => {
    const { deps } = setup();
    const task = await claimHomeTask(deps, token(["copywriting"]));
    expect(task?.kind).toBe("draft_offer_copy");
    const json = JSON.stringify(task);
    expect(json).not.toMatch(/photo\.jpg|secret|meli\.la/);
    expect(task).toMatchObject({
      input: {
        buyerVoice: { untrusted: true, praise: ["ótimo"] },
        channels: ["instagram_carousel", "threads"],
      },
      validation: {
        sourceFactKeys: ["current_price"],
        captionMaxLength: { instagram_carousel: 2200, threads: 2200 },
      },
    });
    // The deck is as long as the format has material for (copy-formats beatsFor).
    if (task?.kind !== "draft_offer_copy") throw new Error("no task");
    expect(task.input.slideCount).toBe(task.input.format?.beats.length);
    expect(task.input.slideCount).toBeGreaterThanOrEqual(3);
    expect(task.input.slideCount).toBeLessThanOrEqual(6);
  });

  it("carries the cast for art direction only when the niche has a main character", async () => {
    const bare = await claimHomeTask(setup().deps, token(["copywriting"]));
    expect(bare).not.toHaveProperty("artDirection");
    const task = await claimHomeTask(setup(undefined, { cast: true }).deps, token(["copywriting"]));
    expect(task).toMatchObject({
      artDirection: {
        product: "Cesto",
        character: { name: "Carla", description: "35, curly hair" },
        otherNames: ["Bia"],
        world: "small rented apartment, late afternoon light",
      },
    });
  });

  it("stores validated scene lines on the slides; a bad line gets the shot's default", async () => {
    const { deps, item } = setup(undefined, { cast: true });
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const lines = slides.map((slide) => ({
      index: slide.index,
      scene:
        slide.index === 2
          ? "Carla and Bia laughing with the product."
          : `Carla using the product on the ${["first", "second", "third", "fourth", "fifth", "sixth"][slide.index - 1]} shelf, product in focus.`,
    }));
    expect(
      await applyHomeResult(deps, t, {
        jobId: task!.jobId,
        leaseToken: task!.leaseToken,
        result: result({ sceneLines: { lines } }),
      }),
    ).toEqual({ ok: true });
    const stored = item().creativeSlides ?? [];
    expect(stored[0]).toMatchObject({
      sceneLine: "Carla using the product on the first shelf, product in focus.",
      sceneLineSource: "model",
    });
    expect(stored[1]).toMatchObject({ sceneLineSource: "default" });
    expect(stored[1]?.sceneLine).not.toContain("Bia");
    const plain = setup(undefined, { cast: true });
    const task2 = await claimHomeTask(plain.deps, t);
    await applyHomeResult(plain.deps, t, {
      jobId: task2!.jobId,
      leaseToken: task2!.leaseToken,
      result: result(),
    });
    expect(plain.item().creativeSlides?.[0]).not.toHaveProperty("sceneLine");
  });

  it("creates variants and the render job exactly once; a second post is not leased", async () => {
    const { deps, variants, enqueue } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    expect(
      await applyHomeResult(deps, t, {
        jobId: task!.jobId,
        leaseToken: task!.leaseToken,
        result: result(),
      }),
    ).toEqual({ ok: true });
    expect(variants.map((v) => v.caption)).toEqual([
      expect.stringMatching(/Link na bio[\s\S]*#publi/),
      expect.stringMatching(/#publi$/),
    ]);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(
      await applyHomeResult(deps, t, {
        jobId: task!.jobId,
        leaseToken: task!.leaseToken,
        result: result(),
      }),
    ).toEqual({ ok: false, reason: "task_not_leased" });
    expect(variants).toHaveLength(2);
  });

  it("repairs a draft by removing a rule-breaking sentence before validating", async () => {
    const { deps, variants } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const draft = {
      slides,
      captions: {
        instagram_carousel: "Cesto por R$ 100",
        threads: "Cesto por R$ 100. Frete grátis!",
      },
    };
    expect(
      await applyHomeResult(deps, t, {
        jobId: task!.jobId,
        leaseToken: task!.leaseToken,
        result: result({ draft }),
      }),
    ).toEqual({ ok: true });
    expect(variants[1]?.caption).toBe("Cesto por R$ 100.\n\n#publi");
  });

  it("rebuilds when a crash left slides stored without variants", async () => {
    const { deps, variants, enqueue, storeSlides } = setup();
    storeSlides();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    expect(task?.kind).toBe("draft_offer_copy");
    expect(
      await applyHomeResult(deps, t, {
        jobId: task!.jobId,
        leaseToken: task!.leaseToken,
        result: result(),
      }),
    ).toEqual({ ok: true });
    expect(variants).toHaveLength(2);
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "unsupported number",
      {
        draft: {
          slides: slides.map((s, i) => (i === 1 ? { ...s, headline: "Só R$ 37" } : s)),
          captions: { instagram_carousel: "a", threads: "b" },
        },
      },
      "copy_rejected:number_unsupported",
    ],
    [
      "a caption emptied by repair",
      {
        draft: {
          slides: slides.map((s, i) =>
            i === 0 ? { ...s, claims: [{ text: "x", factKey: "nope" }] } : s,
          ),
          captions: { instagram_carousel: "a", threads: "Frete grátis" },
        },
      },
      "copy_rejected:caption_missing",
    ],
  ])("rejects %s with a retry and writes nothing", async (_n, over, reason) => {
    const { deps, state, variants } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const outcome = await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result(over),
    });
    expect(outcome).toEqual({ ok: false, reason });
    expect(state).toMatchObject({ status: "retry", reason });
    expect(variants).toHaveLength(0);
  });

  it("refuses an enabled scene director that is not promoted for copy", async () => {
    const { deps } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const outcome = await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result({ model: "local:qwen3.5-4b" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "copy_model_not_allowlisted" });
  });

  it("refuses a known but disabled model", async () => {
    const { deps, state } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const outcome = await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result({ model: "local:qwen3.8-9b-distill" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "copy_model_not_allowlisted" });
    expect(state.status).toBe("failed");
  });

  it("re-enqueues the render job when copy is already built; a missing channel variant is not built", async () => {
    const built = setup();
    const first = await claimHomeTask(built.deps, token(["copywriting"]));
    await applyHomeResult(built.deps, token(["copywriting"]), {
      jobId: first!.jobId,
      leaseToken: first!.leaseToken,
      result: result(),
    });
    built.enqueue.mockClear();
    built.state.status = "pending";
    expect(await claimHomeTask(built.deps, token(["copywriting"]))).toBeNull();
    expect(built.enqueue).toHaveBeenCalledOnce();
    expect(built.state.status).toBe("done");

    const partial = setup();
    partial.storeSlides();
    partial.variants.push({ contentItemId: itemId, channelId: "ig" } as ContentVariant);
    expect((await claimHomeTask(partial.deps, token(["copywriting"])))?.kind).toBe(
      "draft_offer_copy",
    );
    expect(partial.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a model outside the server policy", async () => {
    const { deps, state } = setup();
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const outcome = await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result({ model: "gpt-x" }),
    });
    expect(outcome).toEqual({ ok: false, reason: "copy_model_not_allowlisted" });
    expect(state.status).toBe("failed");
  });

  it("posts only to the item's niche profile, never another niche's channel", async () => {
    const { deps, variants } = setup([
      channel("a-other-ig", "instagram_carousel", "active", "n2"),
      channel("b-unbound-th", "threads", "active", null),
      channel("ig", "instagram_carousel"),
    ]);
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result(),
    });
    expect(variants.map((v) => v.channelId)).toEqual(["ig"]);
  });

  it("fails permanently when no instagram_carousel or threads channel is active", async () => {
    const { deps, state } = setup([
      channel("ig", "instagram_carousel", "paused"),
      channel("yt", "youtube"),
    ]);
    expect(await claimHomeTask(deps, token(["copywriting"]))).toBeNull();
    expect(state).toMatchObject({ status: "failed", reason: "no_active_channels" });
  });

  it.each([
    [
      "an auto package with scene deps draws scenes first",
      { auto: true, offerScenes: true },
      "generate_offer_scenes",
    ],
    ["an auto package without scene deps renders at once", { auto: true }, "render_creatives"],
    ["a manual item keeps the render path", { offerScenes: true }, "render_creatives"],
  ])("%s", async (_name, options, next) => {
    const { deps, enqueue } = setup(undefined, options);
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result(),
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: next }));
  });
});

describe("draft_offer_copy hook pick", () => {
  const hookOptions = [
    { headline: "Sobra espaço no armário", captionFirstLine: "Cesto que organiza a casa." },
    { headline: "Só R$ 79 hoje", captionFirstLine: "Corre." }, // unsupported number: dropped
  ];
  const decide = (scores: Record<string, number> | Error) =>
    vi.fn(async (request: { state: Record<string, unknown> }) => {
      if (scores instanceof Error) throw scores;
      return {
        requestedModel: "jev-latest",
        resolvedModel: "jev-1.13.0",
        answer: {
          type: "score" as const,
          score: scores[String(request.state.hook)] ?? 0,
          legend: {},
          probabilities: {},
          confidence: 0.9,
        },
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: 1,
      };
    });
  const run = async (
    provider: { decide: ReturnType<typeof decide> } | null,
    audit = vi.fn(async () => "a1"),
  ) => {
    const ctx = setup();
    const deps = (
      provider ? { ...ctx.deps, decisions: { provider, audit: { record: audit } } } : ctx.deps
    ) as HomeTaskDeps;
    const t = token(["copywriting"]);
    const task = await claimHomeTask(deps, t);
    const outcome = await applyHomeResult(deps, t, {
      jobId: task!.jobId,
      leaseToken: task!.leaseToken,
      result: result({
        draft: {
          slides,
          captions: { instagram_carousel: "Cesto por R$ 100", threads: "Cesto por R$ 100" },
          hookOptions,
        },
      }),
    });
    return { ...ctx, outcome, audit, cover: ctx.item().creativeSlides?.[0]?.headline };
  };

  it("uses the validated option Jev scores highest and audits the decision", async () => {
    const provider = { decide: decide({ "R$ 100 no cesto": 1.1, "Sobra espaço no armário": 2.7 }) };
    const { outcome, cover, variants, audit, state } = await run(provider);
    expect(outcome).toEqual({ ok: true });
    expect(state.status).toBe("done");
    expect(cover).toBe("Sobra espaço no armário");
    expect(variants[1]?.caption).toMatch(/^Cesto que organiza a casa\./);
    expect(provider.decide).toHaveBeenCalledTimes(2);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.decision.hook_picked",
        systemActor: "system:jev-hook-pick",
        targetType: "ContentItem",
        metadata: expect.objectContaining({
          status: "picked",
          chosenIndex: 1,
          candidatesJson: JSON.stringify(["R$ 100 no cesto", "Sobra espaço no armário"]),
          scoresJson: JSON.stringify([1.1, 2.7]),
          resolvedModel: "jev-1.13.0",
        }),
      }),
    );
  });

  it("keeps the original and completes when Jev or the audit fails", async () => {
    const audit = vi.fn(async () => {
      throw new Error("db down");
    });
    const { outcome, cover, state } = await run(
      { decide: decide(new Error("jev_unavailable")) },
      audit,
    );
    expect(outcome).toEqual({ ok: true });
    expect(state.status).toBe("done");
    expect(cover).toBe("R$ 100 no cesto");
  });

  it("keeps the original without a decision provider", async () => {
    const { outcome, cover } = await run(null);
    expect(outcome).toEqual({ ok: true });
    expect(cover).toBe("R$ 100 no cesto");
  });
});
