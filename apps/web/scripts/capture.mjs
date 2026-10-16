#!/usr/bin/env node
/**
 * Panel screenshot harness: every screen, API mocked, no login, no network.
 *
 *   cd apps/web && npx vite --host 127.0.0.1 --port 5173   # in another shell
 *   node scripts/capture.mjs [--only <name>[,<name>...]]    # BASE=http://127.0.0.1:5173
 *
 * Playwright: tries `playwright` / `playwright-core` from node_modules, then the scratchpad copy
 * (`npm i playwright-core` in /tmp/claude-504429705/.../scratchpad/pw; browsers in ~/.cache/ms-playwright).
 * Override with PW_PATH=/abs/path/to/playwright-core. Output: apps/web/.impeccable/review/ (overwritten).
 * Names: revisar links conteudos ofertas nichos resultados integracoes inspector signin invite.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", ".impeccable", "review");

const loadChromium = () => {
  const require = createRequire(import.meta.url);
  for (const id of [process.env.PW_PATH, "playwright", "playwright-core"]) {
    if (!id) continue;
    try {
      return require(id).chromium;
    } catch {
      /* try next */
    }
  }
  throw new Error("playwright not importable: npm i playwright-core (see header comment)");
};

/* ---------- fixtures (shapes match readPanel & friends in src/features/panel/panel-data.ts) ---------- */

const WS = "ws-1";
const now = Date.now();
const ago = (hours) => new Date(now - hours * 3_600_000).toISOString();
const brl = (reais) => ({ amountMinor: Math.round(reais * 100), currency: "BRL" });

// Product-ish solid colors with a label; served by the https://fixtures.local/** route below.
const img = (label, color, w, h) =>
  `https://fixtures.local/${w}x${h}/${color}/${encodeURIComponent(label)}.svg`;
const feed = (label, color) => ({ url: img(label, color, 1080, 1350), width: 1080, height: 1350 });
const story = (label, color) => ({ url: img(label, color, 1080, 1920), width: 1080, height: 1920 });

const niches = [
  {
    id: "n1",
    name: "Example Shop Home",
    slug: "exampleshopcasa",
    state: "active",
    languages: ["pt-BR"],
  },
  {
    id: "n2",
    name: "Example Shop Beleza",
    slug: "exampleshopbeleza",
    state: "active",
    languages: ["pt-BR"],
  },
  {
    id: "n3",
    name: "Example Shop Tech",
    slug: "exampleshoptech",
    state: "active",
    languages: ["pt-BR"],
  },
];
const channels = [
  { id: "c1", kind: "instagram_carousel", label: "@exampleshop.home", status: "active" },
  { id: "c2", kind: "instagram_reels", label: "@exampleshop.beleza", status: "active" },
  { id: "c3", kind: "tiktok_video", label: "@exampleshop.tech", status: "active" },
];
const offers = [
  [
    "o1",
    "Organizador de gavetas em bambu ajustável 6 divisórias",
    "n1",
    89.9,
    119.9,
    "active",
    3,
    "d9a441",
  ],
  ["o2", "Jogo de panelas antiaderente 5 peças", "n1", 249.0, 329.0, "active", 30, "c0553a"],
  ["o3", "Sérum facial vitamina C 30 ml", "n2", 64.9, 89.9, "active", 5, "e8a87c"],
  ["o4", "Secador de cabelo íon 2200 W", "n2", 179.9, null, "inactive", 90, "b04a6e"],
  ["o5", "Fone Bluetooth com cancelamento de ruído", "n3", 199.9, 279.9, "active", 2, "3d5a80"],
  ["o6", "Carregador portátil 20000 mAh", "n3", 119.0, null, "active", 12, "2f6f5e"],
].map(([id, title, nicheId, price, list, state, hours, color]) => ({
  id,
  title,
  state,
  nicheId,
  marketplace: "mercado_livre",
  affiliateUrl: `https://mercadolivre.com/sec/${id}`,
  price: brl(price),
  listPrice: list ? brl(list) : null,
  verifiedAt: ago(hours),
  imageUrl: img(title.split(" ").slice(0, 2).join(" "), color, 800, 800),
}));
const offerOf = (id) => offers.find((o) => o.id === id);

// [id, offer, channel, state, evidence age h, slide colors, caption]
const variantSpecs = [
  [
    "v1",
    "o1",
    "c1",
    "ready_for_review",
    3,
    "Gaveta bagunçada nunca mais. Esse organizador de bambu ajusta em 6 divisórias e cabe em qualquer cômoda.\n\nPreço conferido hoje no Mercado Livre. Link na bio.",
  ],
  [
    "v2",
    "o3",
    "c2",
    "ready_for_review",
    5,
    "Pele mais uniforme em poucas semanas? O sérum de vitamina C é o item mais pedido da semana.\n\nPreço conferido hoje. Link na bio.",
  ],
  [
    "v3",
    "o5",
    "c3",
    "ready_for_review",
    72,
    "Fone com cancelamento de ruído por menos de R$ 200. Bateria para o dia inteiro.\n\nConfira o preço atual no link da bio.",
  ],
  [
    "v4",
    "o2",
    "c1",
    "draft",
    8,
    "Panelas antiaderentes que vão do fogão ao forno. Cinco peças, um preço só.",
  ],
  [
    "v5",
    "o6",
    "c3",
    "approved",
    12,
    "Carregador de 20000 mAh: duas cargas completas do celular. Link na bio.",
  ],
  [
    "v6",
    "o4",
    "c2",
    "published",
    40,
    "Secador com íon para reduzir frizz. Frete grátis, direto na bio.",
  ],
  ["v7", "o1", "c1", "published", 200, "Organizador de gavetas: antes e depois em 30 segundos."],
  ["v8", "o5", "c3", "published", 300, "Teste de som do fone: vale a compra?"],
];
const palette = ["d9a441", "c0553a", "3d5a80", "2f6f5e", "b04a6e", "7a5c99", "4f8a8b", "a3a380"];
const variants = [];
const reviewQueue = [];
variantSpecs.forEach(([id, offerId, channelId, state, evidenceHours, caption], i) => {
  const offer = offerOf(offerId);
  const channel = channels.find((c) => c.id === channelId);
  const tall = channel.kind !== "instagram_carousel";
  const make = tall ? story : feed;
  const images = [0, 1, 2, 3].map((n) =>
    make(
      `${offer.title.split(" ").slice(0, 2).join(" ")} ${n + 1}`,
      palette[(i + n) % palette.length],
    ),
  );
  const base = {
    id,
    contentItemId: `ci-${id}`,
    title: offer.title,
    nicheId: offer.nicheId,
    channelId,
    channelKind: channel.kind,
    channelLabel: channel.label,
    state,
    language: "pt-BR",
  };
  variants.push({ ...base, thumbnailUrl: img(offer.title.split(" ")[0], palette[i], 200, 250) });
  if (state !== "ready_for_review") return;
  reviewQueue.push({
    ...base,
    caption,
    policyMode: "manual",
    evidenceVerifiedAt: ago(evidenceHours),
    affiliateUrl: offer.affiliateUrl,
    offer: { id: offer.id, title: offer.title, price: offer.price },
    images,
    qa: {
      render: { state: "ready", reason: null, fidelity: "pass", quality: "pass", sequence: [] },
      reel: tall
        ? {
            verdict: id === "v3" ? "warn" : "pass",
            checks: [
              { id: "loudness", verdict: "pass", detail: null },
              {
                id: "music",
                verdict: id === "v3" ? "warn" : "pass",
                detail: id === "v3" ? "trilha sem licença registrada" : null,
              },
            ],
          }
        : null,
      director: {
        level: id === "v3" ? "REVIEW" : "PASS",
        findings:
          id === "v3"
            ? [
                {
                  dimension: "copy",
                  level: "REVIEW",
                  reason: "A legenda promete bateria sem fonte.",
                  repair: "rewrite_copy",
                },
              ]
            : [],
      },
    },
    slides: images.map((_, n) => ({
      index: n + 1,
      scene: n > 0,
      storyScene: n === 0 && tall,
      sceneLine: `Cena ${n + 1}: ${offer.title}`,
      sceneLineSource: "director",
      voiceLine: `Fala do slide ${n + 1}.`,
      history: [],
    })),
  });
});

const performance = {
  posts: [
    ["v7", "c1", 240, 18400, 15200, 610, 220, 702, 640, 0.038, "https://instagram.com/p/fixture1"],
    [
      "v8",
      "c3",
      320,
      42100,
      38000,
      1300,
      88,
      343,
      301,
      0.0081,
      "https://tiktok.com/@fixture/video/1",
    ],
  ].map(
    ([
      contentVariantId,
      channelId,
      h,
      views,
      reach,
      likes,
      saves,
      clicks,
      uniqueClicks,
      clickRate,
      platformUrl,
    ]) => ({
      contentVariantId,
      channelId,
      publishedAt: ago(h),
      observedAt: ago(2),
      platformUrl,
      metrics: { views, reach, likes, saves },
      clicks,
      uniqueClicks,
      clickRate,
    }),
  ),
};

const panel = {
  setup: {
    stages: [
      { id: "plugins", status: "done", action: "" },
      { id: "niche_research", status: "done", action: "" },
      { id: "structure", status: "done", action: "" },
      { id: "integrations", status: "next", action: "" },
      { id: "first_post", status: "pending", action: "" },
      { id: "automations", status: "pending", action: "", optional: true },
    ],
  },
  niches,
  channels,
  offers,
  reviewQueue,
  variants,
  connections: [
    {
      id: "pc-1",
      provider: "post_for_me",
      mode: "api_key",
      status: "active",
      accountId: "pfm_acct_8841",
    },
  ],
  attribution: {
    totalClicks: 1045,
    rows: [
      { key: "exampleshopcasa", clicks: 702, uniqueClicks: 640, lastClickAt: ago(1) },
      { key: "exampleshoptech", clicks: 343, uniqueClicks: 301, lastClickAt: ago(6) },
    ],
  },
  performance,
};

const failedJobs = {
  jobs: [
    {
      jobId: "job-1",
      name: "render_reel",
      reason: "timeout while rendering",
      at: ago(3),
      title: "Auto · Venda · Secador de cabelo íon 2200 W",
    },
    {
      jobId: "job-2",
      name: "draft_offer_copy",
      reason: "INVALID_CONTENT: caption too long",
      at: ago(26),
      title: "Auto · Venda · Jogo de panelas antiaderente 5 peças",
    },
  ],
};
const linkQueue = {
  total: 4,
  items: [
    [
      "Cafeteira elétrica 15 xícaras inox",
      "Example Shop Home",
      159.9,
      ["best seller #3 in its category", "free shipping", "about 800 sold"],
    ],
    [
      "Escova alisadora elétrica",
      "Example Shop Beleza",
      99.9,
      ["free shipping", "rating unavailable from Mercado Livre"],
    ],
    ["Mouse sem fio ergonômico", "Example Shop Tech", 74.9, ["about 1200 sold"]],
    [
      "Luminária de mesa LED recarregável",
      "Example Shop Home",
      69.0,
      ["best seller #1 in its category"],
    ],
  ].map(([title, nicheName, price, reasons], i) => ({
    candidateId: `cand-${i + 1}`,
    nicheName,
    title,
    listingUrl: `https://produto.mercadolivre.com.br/MLB-${1000 + i}`,
    affiliateLinkBuilderUrl: `https://www.mercadolivre.com.br/afiliados/linkbuilder#${1000 + i}`,
    priceMinor: Math.round(price * 100),
    currency: "BRL",
    reasons,
  })),
};

const session = { authenticated: true, user: { id: "u-1", email: "operator@example.com" } };
const workspaces = { workspaces: [{ id: WS, name: "Content Factory", role: "owner" }] };

const apiAnswer = (pathname, signedOut) => {
  if (pathname === "/v1/auth/session") return signedOut ? { authenticated: false } : session;
  if (pathname === "/v1/me/workspaces") return workspaces;
  const m = pathname.match(/^\/v1\/workspaces\/[^/]+\/(.+)$/);
  switch (m?.[1]) {
    case "panel":
      return panel;
    case "affiliate-link-queue":
      return linkQueue;
    case "failed-jobs":
      return failedJobs;
    case "provider-connections":
      return { connections: panel.connections };
    case "operator-context":
      return { niches: niches.map(({ name }) => ({ name })) };
    default:
      return { error: { code: "FIXTURE_MISSING", message: pathname } };
  }
};

const svg = (w, h, color, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
  `<rect width="100%" height="100%" fill="#${color}"/><rect x="${w * 0.2}" y="${h * 0.28}" width="${w * 0.6}" height="${h * 0.44}" rx="${w * 0.04}" fill="#fff" fill-opacity=".22"/>` +
  `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${w * 0.07}" font-weight="700" text-anchor="middle" dominant-baseline="middle">${label.replace(/[<&]/g, "")}</text></svg>`;

/* ---------- capture ---------- */

const sections = [
  "revisar",
  "links",
  "conteudos",
  "ofertas",
  "nichos",
  "resultados",
  "integracoes",
];
const viewports = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const jobs = [
  ...sections.map((name) => ({ name, path: name === "revisar" ? "/" : `/${name}` })),
  { name: "inspector", path: "/", open: true },
  { name: "signin", path: "/", signedOut: true },
  { name: "invite", path: "/invitations/abc123" },
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1]?.split(",")) : null;

const chromium = loadChromium();
mkdirSync(OUT, { recursive: true });
// The installed browser build may lag the playwright version: fall back to the newest cached headless shell.
const cache = join(homedir(), ".cache", "ms-playwright");
const shell = existsSync(cache)
  ? readdirSync(cache)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort()
      .reverse()
      .map((d) => join(cache, d, "chrome-headless-shell-linux64", "chrome-headless-shell"))
      .find(existsSync)
  : undefined;
const browser = await chromium.launch(
  shell && !existsSync(chromium.executablePath()) ? { executablePath: shell } : {},
);
try {
  for (const job of jobs.filter(({ name }) => !only || only.has(name))) {
    for (const [vpName, viewport] of Object.entries(viewports)) {
      const context = await browser.newContext({
        viewport,
        reducedMotion: "reduce",
        locale: "pt-BR",
        timezoneId: "America/Sao_Paulo",
        deviceScaleFactor: 1,
        isMobile: vpName === "mobile",
        hasTouch: vpName === "mobile",
      });
      await context.route("https://fixtures.local/**", (route) => {
        const [, w, h, color, label] =
          new URL(route.request().url()).pathname.match(
            /^\/(\d+)x(\d+)\/([0-9a-f]+)\/(.+)\.svg$/,
          ) ?? [];
        return route.fulfill({
          contentType: "image/svg+xml",
          headers: { "access-control-allow-origin": "*" },
          body: svg(
            Number(w) || 800,
            Number(h) || 800,
            color ?? "888888",
            decodeURIComponent(label ?? ""),
          ),
        });
      });
      await context.route(
        (url) => url.origin === BASE && url.pathname.startsWith("/v1/"),
        (route) => {
          const { pathname } = new URL(route.request().url());
          const get = route.request().method() === "GET";
          return route.fulfill({
            status: get ? 200 : 200,
            contentType: "application/json",
            body: JSON.stringify(
              get ? apiAnswer(pathname, job.signedOut) : { results: [{ status: "saved" }] },
            ),
          });
        },
      );
      const page = await context.newPage();
      await page.goto(`${BASE}${job.path}`, { waitUntil: "networkidle" });
      if (job.open) {
        await page.locator("button.row").first().click();
        await page.locator(".inspector").waitFor();
      }
      // Unicode-range faces load lazily; ask for every weight the panel uses before reading fonts.ready.
      await page.evaluate(async () => {
        await Promise.all(
          ["400", "700", "800"].map((weight) =>
            document.fonts.load(`${weight} 16px "Martian Mono"`, "Aã"),
          ),
        );
        await document.fonts.ready;
      });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      const file = join(OUT, `${vpName}-${job.name}.png`);
      // The mobile ticket is a fixed full-screen slip: capture the viewport, not the page under it.
      await page.screenshot({ path: file, fullPage: !(job.open && vpName === "mobile") });
      console.log(file);
      await context.close();
    }
  }
} finally {
  await browser.close();
}
