import { describe, expect, it } from "vitest";
import { mediaOf, packagesOf, warningsOf } from "./inbox.js";
import {
  checkLabel,
  createPanelClient,
  directorRepairs,
  failedReasonText,
  failedStepLabel,
  linkResultMessage,
  packageTitle,
  readFailedJobs,
  readQa,
  reasonLabel,
  relativeWhen,
  sceneSlotOf,
  sceneStatusText,
  stageOf,
  verdictTone,
} from "./panel-data.js";
import { rejectionText } from "./review.js";

const emptyPanel = {
  setup: null,
  niches: [],
  channels: [],
  offers: [],
  reviewQueue: [],
  variants: [],
  connections: [],
  attribution: null,
  performance: null,
};

describe("inbox packages", () => {
  const variant = (over: Record<string, unknown>) => ({
    id: "v",
    contentItemId: "c1",
    title: "Pacote",
    nicheId: "n1",
    channelId: "ch",
    channelKind: "instagram_carousel",
    channelLabel: null,
    state: "draft",
    language: "pt-BR",
    thumbnailUrl: "https://cdn/a",
    ...over,
  });
  const item = (over: Record<string, unknown>) => ({
    id: "v1",
    contentItemId: "c1",
    title: "Pacote",
    nicheId: "n1",
    channelId: "ch",
    channelKind: "instagram_carousel",
    channelLabel: null,
    caption: "Legenda",
    language: "pt-BR",
    state: "draft",
    policyMode: null,
    evidenceVerifiedAt: null,
    affiliateUrl: null,
    offer: null,
    images: [{ url: "https://cdn/a", width: null, height: null, mimeType: "image/png" }],
    qa: readQa({ render: { state: "rendered", fidelity: "warn" } }),
    slides: [],
    ...over,
  });

  it("groups rendered formats of one content item into one ticket and counts the rest", () => {
    const data = {
      ...emptyPanel,
      variants: [
        variant({ id: "v1" }),
        variant({ id: "v2", channelKind: "threads" }),
        variant({ id: "v3", channelKind: "instagram_reels", thumbnailUrl: null }),
        variant({ id: "v4", contentItemId: "c2", state: "approved" }),
      ],
      reviewQueue: [
        item({ id: "v1" }),
        item({
          id: "v2",
          channelKind: "instagram_reels",
          images: [
            { url: "https://cdn/reel.mp4", width: null, height: null, mimeType: "video/mp4" },
          ],
          qa: readQa({ reel: { verdict: "pass", checks: [] } }),
        }),
      ],
    } as unknown as Parameters<typeof packagesOf>[0];
    const packages = packagesOf(data);
    expect(packages).toHaveLength(1);
    expect(packages[0]).toMatchObject({ contentItemId: "c1", inProduction: 1 });
    expect(packages[0]?.variants.map(({ id }) => id)).toEqual(["v1", "v2"]);
    const media = mediaOf(packages[0]!);
    expect(media.video?.url).toBe("https://cdn/reel.mp4");
    expect(media.slides.map(({ url }) => url)).toEqual(["https://cdn/a"]);
    expect(warningsOf(packages[0]!)).toEqual(["produto: atenção"]);
  });
});

describe("panel rejection text", () => {
  it("puts typed codes before the note in the format the server parses", () => {
    expect(rejectionText(["BAD_PRODUCT", "AI_LOOK"], " tampa ")).toBe(
      "BAD_PRODUCT, AI_LOOK: tampa",
    );
    expect(rejectionText(["BAD_HOOK"], "")).toBe("BAD_HOOK");
    expect(rejectionText([], " só nota ")).toBe("só nota");
  });
});

describe("quality director row", () => {
  it("keeps the carousel sequence and words the director's repairs once each", () => {
    const qa = readQa({
      render: { state: "rendered", reason: null, sequence: ["duplicate_scene:2,3", 7] },
      reel: null,
      director: {
        level: "BLOCK",
        findings: [
          {
            dimension: "sequence",
            level: "BLOCK",
            reason: "duplicate_scene:2,3",
            repair: "redraw_duplicate_scene",
          },
          { dimension: "product", level: "WARN", reason: "x", repair: "redraw_scene" },
          { dimension: "product", level: "WARN", reason: "y", repair: "redraw_scene" },
          { broken: true },
        ],
      },
    });
    expect(qa.render?.sequence).toEqual(["duplicate_scene:2,3"]);
    expect(qa.director && directorRepairs(qa.director)).toEqual([
      "redesenhar a cena repetida",
      "redesenhar a cena",
    ]);
  });
});

describe("review QA rows", () => {
  it("reads the gates tolerantly and words the scene status for the operator", () => {
    expect(readQa(undefined)).toEqual({ render: null, reel: null });
    const qa = readQa({
      render: {
        state: "rendered",
        reason: "in_scene_partial:attempts_exhausted:1:feed:product_absent",
        fidelity: "warn",
        quality: "pass",
      },
      reel: { verdict: "warn", checks: [{ id: "music", verdict: "warn" }, { bad: true }] },
    });
    expect(qa.reel).toEqual({
      verdict: "warn",
      checks: [{ id: "music", verdict: "warn", detail: null }],
    });
    expect(sceneStatusText(qa.render!)).toBe("Parcial: slide 1 em recorte (product_absent)");
    expect(
      sceneStatusText({
        state: "rendered",
        reason: "in_scene_fallback:main_character_sheet_missing",
        fidelity: null,
        quality: null,
      }),
    ).toBe("Recorte em todos os slides (main_character_sheet_missing)");
    expect(
      sceneStatusText({ state: "rendered", reason: null, fidelity: null, quality: null }),
    ).toBe("Em cena");
    expect(verdictTone("block")).toBe("bad");
    expect(checkLabel("music")).toBe("sem trilha");
  });
});

describe("scene slot behind a rendered slide", () => {
  const slides = [
    {
      index: 1,
      scene: true,
      storyScene: true,
      sceneLine: null,
      sceneLineSource: null,
      voiceLine: null,
      history: [],
    },
    {
      index: 2,
      scene: false,
      storyScene: false,
      sceneLine: null,
      sceneLineSource: null,
      voiceLine: null,
      history: [],
    },
    {
      index: 3,
      scene: true,
      storyScene: false,
      sceneLine: null,
      sceneLineSource: null,
      voiceLine: null,
      history: [],
    },
  ];
  it("maps the story cover to its own scene and other slides to the feed scene", () => {
    expect(sceneSlotOf(slides, 0, true)).toEqual({ slideIndex: 1, canvas: "story" });
    expect(sceneSlotOf(slides, 0, false)).toEqual({ slideIndex: 1, canvas: "feed" });
    expect(sceneSlotOf(slides, 2, true)).toEqual({ slideIndex: 3, canvas: "feed" });
    // A cut-out slide has no scene to send back.
    expect(sceneSlotOf(slides, 1, false)).toBeNull();
    expect(sceneSlotOf(slides, 5, false)).toBeNull();
  });
});

describe("affiliate link queue", () => {
  it("translates known ranker reasons and keeps unknown ones", () => {
    expect(reasonLabel("best seller #1 in its category")).toBe("mais vendido #1 na categoria");
    expect(reasonLabel("rating unavailable from Mercado Livre")).toBe("sem nota no ML");
    expect(reasonLabel("free shipping")).toBe("frete grátis");
    expect(reasonLabel("about 300 sold")).toBe("~300 vendidos");
    expect(reasonLabel("good")).toBe("good");
  });

  it("words submit results for the owner", () => {
    expect(linkResultMessage({ status: "linked", offerState: "active" }).ok).toBe(true);
    expect(linkResultMessage({ status: "wrong_product" })).toEqual({
      ok: false,
      message: "Este link é de outro produto.",
    });
    expect(linkResultMessage({ status: "invalid", reason: "host_not_allowed" }).ok).toBe(false);
  });

  it("reads the queue and posts one link through the client", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const respond = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const client = createPanelClient(((url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return url.endsWith("affiliate-link-queue")
        ? respond({
            total: 1,
            items: [
              {
                candidateId: "c1",
                nicheName: "Casa",
                title: "Panela",
                listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
                affiliateLinkBuilderUrl: "https://www.mercadolivre.com.br/afiliados/linkbuilder",
                priceMinor: 9990,
                currency: "BRL",
                reasons: ["free shipping"],
              },
            ],
          })
        : respond({ results: [{ candidateId: "c1", status: "linked" }] });
    }) as typeof fetch);
    const queue = await client.linkQueue("w1");
    expect(queue).toMatchObject({ total: 1, items: [{ candidateId: "c1", nicheName: "Casa" }] });
    const saved = await client.submitLink("w1", "c1", "https://mercadolivre.com/sec/x");
    expect(saved.ok).toBe(true);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      links: [{ candidateId: "c1", affiliateUrl: "https://mercadolivre.com/sec/x" }],
    });
    expect(calls[1]?.url).toBe("/v1/workspaces/w1/affiliate-links");
  });
});

describe("failed packages", () => {
  it("words each retryable step in pt-BR and reads the list defensively", () => {
    expect(failedStepLabel("render_reel")).toBe("Reel");
    expect(failedStepLabel("produce_offer_package")).toBe("preparar pacote");
    expect(failedReasonText("build_INVALID_CONTENT")).toMatch(/refazer/);
    expect(packageTitle("Auto · Venda · Glitter Gel 35g")).toBe("Glitter Gel 35g");
    expect(packageTitle(null)).toBe("Pacote sem título");
    expect(
      readFailedJobs({
        jobs: [{ jobId: "j", name: "render_reel", reason: "x", at: "2026-10-15T00:00:00Z" }, 3],
      }),
    ).toEqual([
      { jobId: "j", name: "render_reel", reason: "x", at: "2026-10-15T00:00:00Z", title: null },
    ]);
    expect(relativeWhen("2026-10-15T00:00:00Z", Date.parse("2026-10-15T03:00:00Z"))).toBe("há 3 h");
  });

  it("lists and retries through the failed-jobs routes", async () => {
    const calls: string[] = [];
    const client = createPanelClient((async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return new Response(JSON.stringify({ jobs: [], retried: true }), { status: 200 });
    }) as typeof fetch);
    expect(await client.failedJobs("w")).toEqual([]);
    expect((await client.retryJob("w", "j")).ok).toBe(true);
    expect(calls).toEqual([
      "GET /v1/workspaces/w/failed-jobs",
      "POST /v1/workspaces/w/failed-jobs/j/retry",
    ]);
  });
});

describe("panel stage", () => {
  const none = new Set<string>();
  it("sends a rendered draft to review and keeps an unrendered one in production", () => {
    expect(stageOf({ id: "a", state: "draft", thumbnailUrl: "https://x/1.png" }, none)).toBe(
      "review",
    );
    expect(stageOf({ id: "b", state: "draft", thumbnailUrl: null }, none)).toBe("draft");
    expect(stageOf({ id: "c", state: "ready_for_review", thumbnailUrl: null }, none)).toBe(
      "review",
    );
  });
});
