export type Money = Readonly<{ amountMinor: number; currency: string }>;

export type PanelNiche = Readonly<{
  id: string;
  name: string;
  slug: string | null;
  state: string;
  languages: readonly string[];
}>;

export type PanelChannel = Readonly<{
  id: string;
  kind: string;
  label: string;
  status: string;
}>;

export type PanelOffer = Readonly<{
  id: string;
  title: string;
  state: string;
  nicheId: string | null;
  marketplace: string | null;
  affiliateUrl: string | null;
  price: Money | null;
  listPrice: Money | null;
  verifiedAt: string | null;
  imageUrl: string | null;
}>;

export type PanelImage = Readonly<{
  url: string;
  width: number | null;
  height: number | null;
  /** `video/mp4` for a Reel; null when the API predates the field (treated as an image). */
  mimeType: string | null;
}>;
export const isVideo = (image: Pick<PanelImage, "mimeType">): boolean =>
  image.mimeType?.startsWith("video/") ?? false;

/** The automatic gates' conclusions, as the API sends them (null when nothing ran yet). */
export type PanelReviewQa = Readonly<{
  render: Readonly<{
    state: string;
    reason: string | null;
    fidelity: string | null;
    quality: string | null;
    sequence?: readonly string[];
  }> | null;
  reel: Readonly<{
    verdict: string;
    checks: readonly Readonly<{ id: string; verdict: string; detail: string | null }>[];
  }> | null;
  /** QA v2 (advisory): absent from APIs that predate it. */
  director?: Readonly<{
    level: string;
    findings: readonly Readonly<{
      dimension: string;
      level: string;
      reason: string;
      repair: string;
    }>[];
  }>;
}>;

const repairLabels: Readonly<Record<string, string>> = {
  redraw_scene: "redesenhar a cena",
  composite_product: "usar o produto real recortado",
  redraw_duplicate_scene: "redesenhar a cena repetida",
  relayout_text: "reposicionar o texto",
  rewrite_copy: "reescrever o texto",
  reorder_slides: "reordenar os slides",
  add_licensed_music: "adicionar trilha licenciada",
  record_music_licence: "registrar a licença da trilha",
  regenerate_voice: "regerar a narração",
  owner_review: "revisão sua",
};
/** "BLOCK" -> the same words the gate verdicts use. */
export const directorLevel = (level: string): string => level.toLowerCase();
/** Distinct repairs, worst finding first, in the reviewer's words. */
export const directorRepairs = (
  director: NonNullable<PanelReviewQa["director"]>,
): readonly string[] => [
  ...new Set(director.findings.map((finding) => repairLabels[finding.repair] ?? finding.repair)),
];

export type PanelReviewItem = Readonly<{
  id: string;
  contentItemId: string;
  title: string;
  nicheId: string | null;
  channelId: string;
  channelKind: string | null;
  channelLabel: string | null;
  caption: string;
  language: string;
  state: string;
  policyMode: string | null;
  evidenceVerifiedAt: string | null;
  affiliateUrl: string | null;
  offer: Readonly<{ id: string; title: string; price: Money | null }> | null;
  images: readonly PanelImage[];
  qa: PanelReviewQa;
  slides: readonly PanelSlidePlan[];
}>;

export type PanelSlidePlan = Readonly<{
  index: number;
  scene: boolean;
  storyScene: boolean;
  sceneLine: string | null;
  sceneLineSource: string | null;
  voiceLine: string | null;
  history: readonly Readonly<{
    url: string;
    canvas: string;
    attempt: number;
    reasons: readonly string[];
  }>[];
}>;
const readSlidePlan = (value: unknown): PanelSlidePlan | null =>
  isRecord(value) && typeof value.index === "number"
    ? {
        index: value.index,
        scene: value.scene === true,
        storyScene: value.storyScene === true,
        sceneLine: strOrNullOf(value.sceneLine),
        sceneLineSource: strOrNullOf(value.sceneLineSource),
        voiceLine: strOrNullOf(value.voiceLine),
        history: compact(
          (Array.isArray(value.history) ? value.history : []).map((entry: unknown) =>
            isRecord(entry) && typeof entry.url === "string"
              ? {
                  url: entry.url,
                  canvas: typeof entry.canvas === "string" ? entry.canvas : "feed",
                  attempt: typeof entry.attempt === "number" ? entry.attempt : 0,
                  reasons: Array.isArray(entry.reasons)
                    ? entry.reasons.filter((r): r is string => typeof r === "string")
                    : [],
                }
              : null,
          ),
        ),
      }
    : null;
/** The scene slot behind the rendered image at `position` (0-based) on this channel, if any. */
export const sceneSlotOf = (
  slides: readonly PanelSlidePlan[],
  position: number,
  story: boolean,
): Readonly<{ slideIndex: number; canvas: "feed" | "story" }> | null => {
  const slide = slides.find((entry) => entry.index === position + 1);
  if (!slide) return null;
  // Only the cover has its own story scene; other story slides show the feed scene.
  if (story && slide.index === 1 && slide.storyScene) return { slideIndex: 1, canvas: "story" };
  return slide.scene ? { slideIndex: slide.index, canvas: "feed" } : null;
};

export type PanelVariant = Readonly<{
  id: string;
  contentItemId: string;
  title: string;
  nicheId: string | null;
  channelId: string;
  channelKind: string | null;
  channelLabel: string | null;
  state: string;
  language: string;
  thumbnailUrl: string | null;
}>;

export type PanelConnection = Readonly<{
  id: string;
  provider: string;
  mode: string;
  status: string;
  accountId: string | null;
}>;

export type SetupStage = Readonly<{
  id: string;
  status: "done" | "next" | "pending" | "unavailable";
  action: string;
  optional?: boolean;
}>;

export type AttributionRow = Readonly<{
  key: string;
  clicks: number;
  uniqueClicks: number;
  lastClickAt: string | null;
}>;

export type PerformancePost = Readonly<{
  contentVariantId: string;
  channelId: string;
  publishedAt: string | null;
  observedAt: string;
  platformUrl: string | null;
  metrics: Readonly<Record<string, number | undefined>>;
  clicks: number;
  uniqueClicks: number;
  clickRate: number | null;
}>;

export type PanelData = Readonly<{
  setup: Readonly<{ stages: readonly SetupStage[] }> | null;
  niches: readonly PanelNiche[];
  channels: readonly PanelChannel[];
  offers: readonly PanelOffer[];
  reviewQueue: readonly PanelReviewItem[];
  variants: readonly PanelVariant[];
  connections: readonly PanelConnection[];
  attribution: Readonly<{ rows: readonly AttributionRow[]; totalClicks: number }> | null;
  performance: Readonly<{ posts: readonly PerformancePost[] }> | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const readMoney = (value: unknown): Money | null =>
  isRecord(value) && Number.isInteger(value.amountMinor) && typeof value.currency === "string"
    ? { amountMinor: value.amountMinor as number, currency: value.currency }
    : null;

const readImage = (value: unknown): PanelImage | null =>
  isRecord(value) && typeof value.url === "string"
    ? {
        url: value.url,
        width: numOrNull(value.width),
        height: numOrNull(value.height),
        mimeType: typeof value.mimeType === "string" ? value.mimeType : null,
      }
    : null;

const compact = <T>(values: readonly (T | null)[]): readonly T[] =>
  values.filter((value): value is T => value !== null);

const strOrNullOf = (value: unknown): string | null => (typeof value === "string" ? value : null);
/** Tolerant reader: an older API without `qa`, or a malformed block, reads as "nothing ran". */
export const readQa = (value: unknown): PanelReviewQa => {
  const qa = isRecord(value) ? value : {};
  const render = isRecord(qa.render) && typeof qa.render.state === "string" ? qa.render : null;
  const reel = isRecord(qa.reel) && typeof qa.reel.verdict === "string" ? qa.reel : null;
  const director =
    isRecord(qa.director) && typeof qa.director.level === "string" ? qa.director : null;
  const strings = (list: unknown) =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    render: render
      ? {
          state: render.state as string,
          reason: strOrNullOf(render.reason),
          fidelity: strOrNullOf(render.fidelity),
          quality: strOrNullOf(render.quality),
          sequence: strings(render.sequence),
        }
      : null,
    ...(director
      ? {
          director: {
            level: director.level as string,
            findings: compact(
              (Array.isArray(director.findings) ? director.findings : []).map((f: unknown) =>
                isRecord(f) &&
                typeof f.dimension === "string" &&
                typeof f.level === "string" &&
                typeof f.reason === "string" &&
                typeof f.repair === "string"
                  ? { dimension: f.dimension, level: f.level, reason: f.reason, repair: f.repair }
                  : null,
              ),
            ),
          },
        }
      : {}),
    reel: reel
      ? {
          verdict: reel.verdict as string,
          checks: compact(
            (Array.isArray(reel.checks) ? reel.checks : []).map((check: unknown) =>
              isRecord(check) && typeof check.id === "string" && typeof check.verdict === "string"
                ? { id: check.id, verdict: check.verdict, detail: strOrNullOf(check.detail) }
                : null,
            ),
          ),
        }
      : null,
  };
};

/** "Cenas" row: how the slides were drawn, from the render reason the scene task recorded. */
export const sceneStatusText = (render: NonNullable<PanelReviewQa["render"]>): string => {
  const reason = render.reason ?? "";
  if (reason.startsWith("in_scene_partial:")) {
    // Slot keys carry a colon ("1:feed"), so the slot list is matched by shape, not split.
    const parts = reason.match(
      /attempts_exhausted:((?:\d+:(?:feed|story))(?:,\d+:(?:feed|story))*)(?::(.*))?$/,
    );
    const slots = parts?.[1]?.replace(/:feed/g, "").replace(/:story/g, " (story)") ?? "";
    const why = parts?.[2] ?? "";
    return `Parcial: slide ${slots || "?"} em recorte${why ? ` (${why})` : ""}`;
  }
  if (reason.startsWith("in_scene_fallback:")) {
    const why = reason.replace(/^in_scene_fallback:/, "");
    return `Recorte em todos os slides (${why})`;
  }
  if (render.state === "failed") return `Falhou${reason ? ` (${reason})` : ""}`;
  if (render.state === "pending") return "Renderizando";
  return "Em cena";
};

export const verdictTone = (verdict: string): Tone =>
  verdict === "pass" ? "ok" : verdict === "warn" || verdict === "review" ? "review" : "bad";
export const verdictLabel = (verdict: string): string =>
  ({ pass: "ok", warn: "atenção", review: "revisar", block: "bloqueado" })[verdict] ?? verdict;
const checkLabels: Readonly<Record<string, string>> = {
  music: "sem trilha",
  loudness: "volume",
  silence: "silêncio",
  black: "quadro preto",
  freeze: "quadro parado",
  audio_stream: "sem áudio",
  duration: "duração",
};
export const checkLabel = (id: string): string => checkLabels[id] ?? id;

/** Tolerant reader: a malformed row is dropped, never a whole-panel failure. */
export const readPanel = (payload: unknown): PanelData | null => {
  if (!isRecord(payload)) return null;
  const setup = isRecord(payload.setup)
    ? {
        stages: compact(
          list(payload.setup.stages).map((stage) =>
            isRecord(stage) && typeof stage.id === "string" && typeof stage.status === "string"
              ? {
                  id: stage.id,
                  status: stage.status as SetupStage["status"],
                  action: str(stage.action),
                  ...(stage.optional === true ? { optional: true } : {}),
                }
              : null,
          ),
        ),
      }
    : null;
  const attribution = isRecord(payload.attribution)
    ? {
        totalClicks: num(payload.attribution.totalClicks),
        rows: compact(
          list(payload.attribution.rows).map((row) =>
            isRecord(row) && typeof row.key === "string"
              ? {
                  key: row.key,
                  clicks: num(row.clicks),
                  uniqueClicks: num(row.uniqueClicks),
                  lastClickAt: strOrNull(row.lastClickAt),
                }
              : null,
          ),
        ),
      }
    : null;
  const performance = isRecord(payload.performance)
    ? {
        posts: compact(
          list(payload.performance.posts).map((post) =>
            isRecord(post) && typeof post.contentVariantId === "string"
              ? {
                  contentVariantId: post.contentVariantId,
                  channelId: str(post.channelId),
                  publishedAt: strOrNull(post.publishedAt),
                  observedAt: str(post.observedAt),
                  platformUrl: strOrNull(post.platformUrl),
                  metrics: isRecord(post.metrics)
                    ? Object.fromEntries(
                        Object.entries(post.metrics).map(([key, value]) => [
                          key,
                          numOrNull(value) ?? undefined,
                        ]),
                      )
                    : {},
                  clicks: num(post.clicks),
                  uniqueClicks: num(post.uniqueClicks),
                  clickRate: numOrNull(post.clickRate),
                }
              : null,
          ),
        ),
      }
    : null;
  return {
    setup,
    niches: compact(
      list(payload.niches).map((niche) =>
        isRecord(niche) && typeof niche.id === "string"
          ? {
              id: niche.id,
              name: str(niche.name),
              slug: strOrNull(niche.slug),
              state: str(niche.state),
              languages: list(niche.languages).map(str),
            }
          : null,
      ),
    ),
    channels: compact(
      list(payload.channels).map((channel) =>
        isRecord(channel) && typeof channel.id === "string"
          ? {
              id: channel.id,
              kind: str(channel.kind),
              label: str(channel.label),
              status: str(channel.status),
            }
          : null,
      ),
    ),
    offers: compact(
      list(payload.offers).map((offer) =>
        isRecord(offer) && typeof offer.id === "string"
          ? {
              id: offer.id,
              title: str(offer.title),
              state: str(offer.state),
              nicheId: strOrNull(offer.nicheId),
              marketplace: strOrNull(offer.marketplace),
              affiliateUrl: strOrNull(offer.affiliateUrl),
              price: readMoney(offer.price),
              listPrice: readMoney(offer.listPrice),
              verifiedAt: strOrNull(offer.verifiedAt),
              imageUrl: strOrNull(offer.imageUrl),
            }
          : null,
      ),
    ),
    reviewQueue: compact(
      list(payload.reviewQueue).map((item) =>
        isRecord(item) && typeof item.id === "string"
          ? {
              id: item.id,
              contentItemId: str(item.contentItemId),
              title: str(item.title),
              nicheId: strOrNull(item.nicheId),
              channelId: str(item.channelId),
              channelKind: strOrNull(item.channelKind),
              channelLabel: strOrNull(item.channelLabel),
              caption: str(item.caption),
              language: str(item.language),
              state: str(item.state),
              policyMode: strOrNull(item.policyMode),
              evidenceVerifiedAt: strOrNull(item.evidenceVerifiedAt),
              affiliateUrl: strOrNull(item.affiliateUrl),
              offer:
                isRecord(item.offer) && typeof item.offer.id === "string"
                  ? {
                      id: item.offer.id,
                      title: str(item.offer.title),
                      price: readMoney(item.offer.price),
                    }
                  : null,
              images: compact(list(item.images).map(readImage)),
              qa: readQa(item.qa),
              slides: compact(list(item.slides).map(readSlidePlan)),
            }
          : null,
      ),
    ),
    variants: compact(
      list(payload.variants).map((variant) =>
        isRecord(variant) && typeof variant.id === "string"
          ? {
              id: variant.id,
              contentItemId: str(variant.contentItemId),
              title: str(variant.title),
              nicheId: strOrNull(variant.nicheId),
              channelId: str(variant.channelId),
              channelKind: strOrNull(variant.channelKind),
              channelLabel: strOrNull(variant.channelLabel),
              state: str(variant.state),
              language: str(variant.language),
              thumbnailUrl: strOrNull(variant.thumbnailUrl),
            }
          : null,
      ),
    ),
    connections: compact(
      list(payload.connections).map((connection) =>
        isRecord(connection) && typeof connection.id === "string"
          ? {
              id: connection.id,
              provider: str(connection.provider),
              mode: str(connection.mode),
              status: str(connection.status),
              accountId: strOrNull(connection.accountId),
            }
          : null,
      ),
    ),
    attribution,
    performance,
  };
};

/* Vocabulary: the desk names things the way the operator does. */

export const stages = [
  { key: "draft", label: "Em produção" },
  { key: "review", label: "Para revisar" },
  { key: "approved", label: "Aprovado" },
  { key: "published", label: "Publicado" },
  { key: "measured", label: "Medido" },
] as const;

export type StageKey = (typeof stages)[number]["key"];

export const stageOf = (
  variant: Readonly<{ id: string; state: string; thumbnailUrl: string | null }>,
  measuredIds: ReadonlySet<string>,
): StageKey | null => {
  if (measuredIds.has(variant.id)) return "measured";
  switch (variant.state) {
    // Approve works from draft, so a draft with rendered media is the owner's to review;
    // one without media is still being produced.
    case "draft":
      return variant.thumbnailUrl ? "review" : "draft";
    case "ready_for_review":
      return "review";
    case "approved":
    case "scheduled":
      return "approved";
    case "published":
      return "published";
    default:
      return null;
  }
};

export const stateLabel = (state: string): string =>
  ({
    draft: "Rascunho",
    ready_for_review: "Para revisar",
    approved: "Aprovado",
    scheduled: "Agendado",
    published: "Publicado",
    rejected: "Devolvido",
    cancelled: "Cancelado",
    active: "Ativo",
    inactive: "Inativo",
    archived: "Arquivado",
    revoked: "Desconectado",
    unhealthy: "Com problema",
    queued: "Na fila",
    publishing: "Publicando",
    retryable_failure: "Falhou, vai tentar de novo",
    permanent_failure: "Falhou",
    unknown_outcome: "Sem confirmação",
  })[state] ?? state;

export type Tone = "review" | "ok" | "wait" | "bad" | "quiet";

const tones: Readonly<Record<string, Tone>> = {
  ready_for_review: "review",
  approved: "ok",
  published: "ok",
  active: "ok",
  scheduled: "wait",
  queued: "wait",
  publishing: "wait",
  unknown_outcome: "wait",
  retryable_failure: "wait",
  unhealthy: "wait",
  rejected: "bad",
  permanent_failure: "bad",
  revoked: "bad",
  cancelled: "quiet",
  draft: "quiet",
  inactive: "quiet",
  archived: "quiet",
};

export const stateTone = (state: string): Tone => tones[state] ?? "quiet";

export const channelLabel = (kind: string | null): string =>
  ({
    instagram_carousel: "Carrossel",
    instagram_stories: "Stories",
    instagram_reels: "Reels",
    threads: "Threads",
    tiktok_photo_post: "TikTok fotos",
    tiktok_video: "TikTok vídeo",
    youtube: "YouTube",
  })[kind ?? ""] ??
  kind ??
  "Canal";

export const channelRatio = (kind: string | null): "4/5" | "9/16" | "16/9" =>
  kind === "youtube"
    ? "16/9"
    : kind === "instagram_carousel" || kind === "threads" || kind === null
      ? "4/5"
      : "9/16";

export const providerLabel = (provider: string): string =>
  ({ post_for_me: "Post For Me", mercado_livre: "Mercado Livre", canva: "Canva" })[provider] ??
  provider;

export const formatMoney = (money: Money): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: money.currency }).format(
    money.amountMinor / 100,
  );

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const formatWhen = (iso: string | null): string => {
  if (!iso) return "sem data";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "sem data" : dateTime.format(date).replace(", ", " às ");
};

export type FailedJobEntry = Readonly<{
  jobId: string;
  name: string;
  reason: string;
  at: string;
  title: string | null;
}>;

const stepLabels: Readonly<Record<string, string>> = {
  produce_offer_package: "preparar pacote",
  draft_offer_copy: "texto",
  generate_offer_scenes: "cenas",
  check_scene_fidelity: "checagem da foto",
  render_creatives: "carrossel",
  render_reel: "Reel",
};

export const failedStepLabel = (name: string): string => stepLabels[name] ?? name;

/** The owner reads plain Portuguese, never an internal code. */
export const failedReasonText = (reason: string): string =>
  reason.includes("INVALID_CONTENT")
    ? "Um texto do pacote ficou fora do tamanho. Já corrigimos: é só refazer."
    : reason.includes("timeout") || reason.includes("aborted")
      ? "O computador demorou demais. É só refazer."
      : "Esta etapa falhou. É só refazer.";

/** Automatic packages are titled "Auto · Venda · <product>"; the owner only needs the product. */
export const packageTitle = (title: string | null): string =>
  title?.replace(/^Auto · Venda · /, "").trim() || "Pacote sem título";

export const relativeWhen = (iso: string, now = Date.now()): string => {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (Number.isNaN(minutes)) return "sem data";
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 1440) return `há ${Math.floor(minutes / 60)} h`;
  return `há ${Math.floor(minutes / 1440)} d`;
};

export const readFailedJobs = (body: unknown): FailedJobEntry[] =>
  isRecord(body) && Array.isArray(body.jobs)
    ? body.jobs.flatMap((raw): FailedJobEntry[] =>
        isRecord(raw) &&
        typeof raw.jobId === "string" &&
        typeof raw.name === "string" &&
        typeof raw.reason === "string" &&
        typeof raw.at === "string"
          ? [
              {
                jobId: raw.jobId,
                name: raw.name,
                reason: raw.reason,
                at: raw.at,
                title: typeof raw.title === "string" ? raw.title : null,
              },
            ]
          : [],
      )
    : [];

export const isFresh = (iso: string | null, hours = 24): boolean =>
  iso !== null && Date.now() - Date.parse(iso) < hours * 3_600_000;

export const formatCount = (value: number): string => new Intl.NumberFormat("pt-BR").format(value);

/* Actions: every call names its outcome so the UI can say what happened. */

export type ActionResult =
  | Readonly<{ ok: true; message?: string }>
  | Readonly<{ ok: false; message: string }>;

export type LinkCandidate = Readonly<{
  candidateId: string;
  nicheName: string | null;
  title: string;
  listingUrl: string;
  affiliateLinkBuilderUrl: string;
  price: Money;
  reasons: readonly string[];
}>;

export type LinkQueue = Readonly<{ total: number; items: readonly LinkCandidate[] }>;

const reasonPatterns: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
  [/^best seller #(\d+) in its category$/, (m) => `mais vendido #${m[1]} na categoria`],
  [/^rating unavailable from Mercado Livre$/, () => "sem nota no ML"],
  [/^free shipping$/, () => "frete grátis"],
  [/^about (\d+) sold$/, (m) => `~${m[1]} vendidos`],
];

/** Known English reasons from the research ranker, in pt-BR; unknown ones pass through. */
export const reasonLabel = (reason: string): string => {
  for (const [pattern, label] of reasonPatterns) {
    const match = reason.match(pattern);
    if (match) return label(match);
  }
  return reason;
};

const readLinkQueue = (body: unknown): LinkQueue | null => {
  if (!isRecord(body) || !Array.isArray(body.items) || typeof body.total !== "number") return null;
  const items = body.items.flatMap((raw): LinkCandidate[] =>
    isRecord(raw) &&
    typeof raw.candidateId === "string" &&
    typeof raw.title === "string" &&
    typeof raw.listingUrl === "string" &&
    typeof raw.affiliateLinkBuilderUrl === "string" &&
    typeof raw.priceMinor === "number" &&
    typeof raw.currency === "string"
      ? [
          {
            candidateId: raw.candidateId,
            nicheName: typeof raw.nicheName === "string" ? raw.nicheName : null,
            title: raw.title,
            listingUrl: raw.listingUrl,
            affiliateLinkBuilderUrl: raw.affiliateLinkBuilderUrl,
            price: { amountMinor: raw.priceMinor, currency: raw.currency },
            reasons: Array.isArray(raw.reasons)
              ? raw.reasons.filter((r): r is string => typeof r === "string")
              : [],
          },
        ]
      : [],
  );
  return { total: body.total, items };
};

const linkRejections: Readonly<Record<string, string>> = {
  host_not_allowed: "Use um link de afiliado do Mercado Livre (https).",
  unsupported_redirect: "Este link não leva a um produto do Mercado Livre.",
  unknown_candidate: "Este produto não está mais na fila.",
};

/** One submit result of the affiliate-links endpoint, worded for the owner. */
export const linkResultMessage = (result: unknown): ActionResult => {
  const status = isRecord(result) ? result.status : undefined;
  const reason = isRecord(result) && typeof result.reason === "string" ? result.reason : "";
  if (status === "linked")
    return isRecord(result) && result.offerState === "draft"
      ? { ok: true, message: "Link salvo. A oferta ficou em rascunho; confira em Ofertas." }
      : { ok: true, message: "Link salvo. A fábrica está montando o pacote." };
  if (status === "already_linked") return { ok: true, message: "Este produto já tem link." };
  const message =
    status === "wrong_product"
      ? "Este link é de outro produto."
      : status === "expired_candidate"
        ? "Este produto saiu da fila."
        : status === "import_failed"
          ? "Não deu para conferir o link agora. Tente de novo."
          : (linkRejections[reason] ?? "Link não aceito.");
  return { ok: false, message };
};

const failure = async (response: Response, fallback: string): Promise<ActionResult> => {
  try {
    const body: unknown = await response.json();
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
        ? body.error.message
        : fallback;
    return { ok: false, message };
  } catch {
    return { ok: false, message: fallback };
  }
};

export const createPanelClient = (request: typeof fetch = fetch) => {
  const call = async (path: string, init: RequestInit, fallback: string): Promise<ActionResult> => {
    try {
      const response = await request(path, {
        credentials: "include",
        headers: { "content-type": "application/json" },
        ...init,
      });
      return response.ok ? { ok: true } : failure(response, fallback);
    } catch {
      return { ok: false, message: "Sem conexão com o servidor. Tente de novo." };
    }
  };
  return {
    load: async (workspaceId: string): Promise<PanelData | null> => {
      const response = await request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/panel`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      return readPanel(await response.json());
    },
    approve: (workspaceId: string, variantId: string) =>
      call(
        `/v1/workspaces/${workspaceId}/content/variants/${encodeURIComponent(variantId)}/approve`,
        { method: "POST", body: "{}" },
        "Não foi possível aprovar este conteúdo.",
      ),
    rejectScene: (
      workspaceId: string,
      contentItemId: string,
      slot: Readonly<{ slideIndex: number; canvas: "feed" | "story" }>,
      reasons: readonly string[],
      note: string,
    ) =>
      call(
        `/v1/workspaces/${workspaceId}/content/items/${encodeURIComponent(contentItemId)}/scenes/reject`,
        { method: "POST", body: JSON.stringify({ ...slot, reasons, note }) },
        "Não foi possível devolver esta cena.",
      ),
    reject: (workspaceId: string, variantId: string, reason: string) =>
      call(
        `/v1/workspaces/${workspaceId}/content/variants/${encodeURIComponent(variantId)}/reject`,
        { method: "POST", body: JSON.stringify({ reason }) },
        "Não foi possível devolver este conteúdo.",
      ),
    publish: (workspaceId: string, variantId: string) =>
      call(
        `/v1/workspaces/${workspaceId}/publications`,
        {
          method: "POST",
          body: JSON.stringify({
            contentVariantId: variantId,
            idempotencyKey: `panel:${variantId}:${Date.now()}`,
          }),
        },
        "Não foi possível publicar este conteúdo.",
      ),
    activateOffer: (workspaceId: string, offerId: string) =>
      call(
        `/v1/workspaces/${workspaceId}/offers/${encodeURIComponent(offerId)}/activate`,
        { method: "POST", body: "{}" },
        "Não foi possível ativar esta oferta.",
      ),
    rejectOffer: (workspaceId: string, offerId: string, reason: string) =>
      call(
        `/v1/workspaces/${workspaceId}/offers/${encodeURIComponent(offerId)}/reject`,
        { method: "POST", body: JSON.stringify({ reason }) },
        "Não foi possível recusar esta oferta.",
      ),
    createOffer: (workspaceId: string, input: Readonly<Record<string, unknown>>) =>
      call(
        `/v1/workspaces/${workspaceId}/offers`,
        { method: "POST", body: JSON.stringify(input) },
        "Confira o título e os links da oferta.",
      ),
    createNiche: (workspaceId: string, input: Readonly<Record<string, unknown>>) =>
      call(
        `/v1/workspaces/${workspaceId}/niches`,
        { method: "POST", body: JSON.stringify(input) },
        "Confira os campos do nicho.",
      ),
    linkQueue: async (workspaceId: string): Promise<LinkQueue | null> => {
      try {
        const response = await request(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/affiliate-link-queue`,
          { credentials: "include" },
        );
        return response.ok ? readLinkQueue(await response.json()) : null;
      } catch {
        return null;
      }
    },
    failedJobs: async (workspaceId: string): Promise<FailedJobEntry[]> => {
      try {
        const response = await request(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/failed-jobs`,
          { credentials: "include" },
        );
        return response.ok ? readFailedJobs(await response.json()) : [];
      } catch {
        return [];
      }
    },
    retryJob: (workspaceId: string, jobId: string) =>
      call(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/failed-jobs/${encodeURIComponent(jobId)}/retry`,
        { method: "POST", body: "{}" },
        "Não foi possível refazer este pacote.",
      ),
    submitLink: async (
      workspaceId: string,
      candidateId: string,
      affiliateUrl: string,
    ): Promise<ActionResult> => {
      const fallback = "Não foi possível salvar o link.";
      try {
        const response = await request(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/affiliate-links`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ links: [{ candidateId, affiliateUrl }] }),
          },
        );
        if (response.status === 400) return { ok: false, message: "Confira o link colado." };
        if (response.status === 403)
          return { ok: false, message: "Você não tem permissão para salvar links." };
        if (!response.ok) return { ok: false, message: fallback };
        const body: unknown = await response.json();
        const first = isRecord(body) && Array.isArray(body.results) ? body.results[0] : undefined;
        return linkResultMessage(first);
      } catch {
        return { ok: false, message: "Sem conexão com o servidor. Tente de novo." };
      }
    },
    invite: (workspaceId: string, email: string, role: "operator" | "reviewer") =>
      call(
        `/v1/workspaces/${workspaceId}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({
            email,
            role,
            expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
          }),
        },
        "Não foi possível enviar o convite.",
      ),
  };
};

export type PanelClient = ReturnType<typeof createPanelClient>;
