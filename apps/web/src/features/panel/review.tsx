import { ArrowLeft, Check, ExternalLink, ImageOff, Send, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertLine, Chip, DeskTitle, Empty } from "./desk.js";
import {
  channelLabel,
  channelRatio,
  checkLabel,
  directorLevel,
  directorRepairs,
  type FailedJobEntry,
  failedReasonText,
  failedStepLabel,
  formatMoney,
  formatWhen,
  isFresh,
  isVideo,
  type PanelClient,
  type PanelData,
  type PanelReviewItem,
  type PanelVariant,
  packageTitle,
  relativeWhen,
  type StageKey,
  sceneSlotOf,
  sceneStatusText,
  stageOf,
  stages,
  stateLabel,
  stateTone,
  verdictLabel,
  verdictTone,
} from "./panel-data.js";

type Role = "owner" | "operator" | "reviewer";

type ReviewDeskProps = Readonly<{
  data: PanelData;
  workspaceId: string;
  role: Role;
  client: PanelClient;
  onChanged: () => Promise<void>;
  title?: string;
  initialStage?: StageKey;
}>;

type Busy = "approve" | "reject" | "publish" | "scene" | null;

/** The rubber stamp that lands on the ticket before it tears off the roll. */
type Seal = Readonly<{ kind: "approve" | "reject"; at: string }>;

const sealTime = (): string =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

const nicheName = (data: PanelData, nicheId: string | null): string | null =>
  data.niches.find(({ id }) => id === nicheId)?.name ?? null;

export const measuredIds = (data: PanelData): ReadonlySet<string> =>
  new Set(data.performance?.posts.map(({ contentVariantId }) => contentVariantId) ?? []);

/** Live counts for the stage rail; a tick animates the count that just changed. */
export const StageRail = ({
  data,
  current,
  onSelect,
}: Readonly<{ data: PanelData; current: StageKey; onSelect: (stage: StageKey) => void }>) => {
  const measured = useMemo(() => measuredIds(data), [data]);
  const counts = useMemo(() => {
    const result: Record<StageKey, number> = {
      draft: 0,
      review: 0,
      approved: 0,
      published: 0,
      measured: 0,
    };
    for (const variant of data.variants) {
      const stage = stageOf(variant, measured);
      if (stage) result[stage] += 1;
    }
    return result;
  }, [data, measured]);
  const previous = useRef(counts);
  const [ticking, setTicking] = useState<StageKey | null>(null);
  useEffect(() => {
    const changed = stages.find(({ key }) => previous.current[key] !== counts[key]);
    previous.current = counts;
    if (!changed) return;
    setTicking(changed.key);
    const timer = window.setTimeout(() => setTicking(null), 220);
    return () => window.clearTimeout(timer);
  }, [counts]);
  return (
    <div className="stage-rail" role="tablist" aria-label="Etapas">
      {stages.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          className="stage"
          aria-current={key === current ? "true" : undefined}
          aria-selected={key === current}
          onClick={() => onSelect(key)}
        >
          {label}
          <output data-tick={ticking === key ? "true" : undefined}>{counts[key]}</output>
        </button>
      ))}
    </div>
  );
};

const Thumb = ({ url, alt }: Readonly<{ url: string | null; alt: string }>) =>
  url ? (
    <img className="row-thumb" src={url} alt={alt} loading="lazy" decoding="async" />
  ) : (
    <span className="row-thumb" aria-hidden="true">
      <ImageOff size={18} />
    </span>
  );

type RowProps = Readonly<{
  variant: PanelVariant;
  data: PanelData;
  selected: boolean;
  leaving: boolean;
  landed: boolean;
  onOpen: () => void;
}>;

export // A rendered draft is ready for the owner; an unrendered one is still in production.
const VariantChip = ({ variant }: Readonly<{ variant: PanelVariant }>) =>
  variant.state === "draft" ? (
    <Chip tone={stateTone(variant.thumbnailUrl ? "ready_for_review" : "draft")}>
      {variant.thumbnailUrl ? "Para revisar" : "Em produção"}
    </Chip>
  ) : (
    <Chip tone={stateTone(variant.state)}>{stateLabel(variant.state)}</Chip>
  );

const VariantRow = ({ variant, data, selected, leaving, landed, onOpen }: RowProps) => {
  const niche = nicheName(data, variant.nicheId);
  const item = data.reviewQueue.find(({ id }) => id === variant.id) ?? null;
  const evidence = item?.evidenceVerifiedAt ?? null;
  return (
    <li>
      <button
        type="button"
        className="row"
        aria-pressed={selected}
        data-leaving={leaving ? "true" : undefined}
        data-landed={landed ? "true" : undefined}
        onClick={onOpen}
      >
        <Thumb url={variant.thumbnailUrl} alt="" />
        <span className="row-body">
          <span className="row-title">{variant.title || "Sem título"}</span>
          <span className="row-meta">
            <strong>{variant.channelLabel || channelLabel(variant.channelKind)}</strong>
            {niche ? <span>{niche}</span> : null}
            {item?.offer?.price ? (
              <span>
                <strong>{formatMoney(item.offer.price)}</strong>
                {evidence ? ` conferido ${formatWhen(evidence).replace(/ às .*$/, "")}` : ""}
                {evidence && !isFresh(evidence) ? ", mais de 24h" : ""}
              </span>
            ) : null}
          </span>
        </span>
        <span className="row-end">
          <VariantChip variant={variant} />
        </span>
      </button>
    </li>
  );
};

type InspectorProps = Readonly<{
  item: PanelReviewItem | null;
  variant: PanelVariant;
  data: PanelData;
  role: Role;
  busy: Busy;
  seal?: Seal | null;
  error: string | null;
  notice: string | null;
  onClose: () => void;
  onApprove: () => void;
  onReject: (reason: string) => void;
  onRejectScene: (
    slot: Readonly<{ slideIndex: number; canvas: "feed" | "story" }>,
    reasons: readonly string[],
    note: string,
  ) => void;
  onPublish: () => void;
}>;

/** Scene-level subset of REVIEW_REASONS; BAD_PRODUCT makes the redraw use the real product. */
const SCENE_REASONS: readonly (readonly [string, string])[] = [
  ["BAD_PRODUCT", "Produto errado"],
  ["BAD_FACE", "Rosto"],
  ["BAD_HAND", "Mãos"],
  ["BAD_CHARACTER", "Personagem"],
  ["AI_LOOK", "Cara de IA"],
  ["OTHER", "Outro"],
];

/** Same codes as core REVIEW_REASONS; the server reads them from the "CODE, CODE: note" prefix. */
const REVIEW_REASONS: readonly (readonly [string, string])[] = [
  ["BAD_PRODUCT", "Produto errado"],
  ["BAD_FACE", "Rosto"],
  ["BAD_HAND", "Mãos"],
  ["BAD_CHARACTER", "Personagem"],
  ["BAD_COPY", "Texto"],
  ["BAD_HOOK", "Gancho fraco"],
  ["BAD_LAYOUT", "Layout"],
  ["BAD_TEXT", "Texto na imagem"],
  ["BAD_VOICE", "Voz"],
  ["BAD_MUSIC", "Música"],
  ["BAD_CAPTIONS", "Legendas"],
  ["BAD_MOTION", "Movimento"],
  ["BAD_PACING", "Ritmo"],
  ["AI_LOOK", "Cara de IA"],
  ["OTHER", "Outro"],
];

export const rejectionText = (codes: readonly string[], note: string): string => {
  const text = note.trim();
  if (codes.length === 0) return text;
  return text ? `${codes.join(", ")}: ${text}` : codes.join(", ");
};

export const Inspector = ({
  item,
  variant,
  data,
  role,
  busy,
  seal = null,
  error,
  notice,
  onClose,
  onApprove,
  onReject,
  onRejectScene,
  onPublish,
}: InspectorProps) => {
  const [reason, setReason] = useState("");
  const [codes, setCodes] = useState<readonly string[]>([]);
  const toggleCode = (code: string) =>
    setCodes((current) =>
      current.includes(code) ? current.filter((c) => c !== code) : [...current, code],
    );
  const [returning, setReturning] = useState(false);
  // Phone-size preview: slides at a phone's CSS width, story UI bands shaded (brief 13).
  const [phone, setPhone] = useState(false);
  const kind = item?.channelKind ?? variant.channelKind;
  const ratio = channelRatio(kind);
  const images =
    item?.images ??
    (variant.thumbnailUrl
      ? [{ url: variant.thumbnailUrl, width: null, height: null, mimeType: null }]
      : []);
  const canReview = variant.state === "ready_for_review" && item !== null;
  const canPublish = variant.state === "approved" && role !== "reviewer";
  // One bad scene goes back alone while the package is still in review (brief 23).
  const canRejectScene =
    item !== null && ["draft", "ready_for_review", "rejected"].includes(variant.state);
  const niche = nicheName(data, variant.nicheId);
  const evidenceFresh = isFresh(item?.evidenceVerifiedAt ?? null);

  return (
    <aside className="inspector" aria-labelledby="inspector-title">
      {seal ? (
        <div className="seal" data-kind={seal.kind} role="status">
          <strong>{seal.kind === "approve" ? "Aprovado" : "Devolvido"}</strong>
          <span>{seal.at}</span>
        </div>
      ) : null}
      <div className="inspector-head">
        <button type="button" onClick={onClose} aria-label="Fechar">
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h2 id="inspector-title">{variant.title || "Sem título"}</h2>
        <VariantChip variant={variant} />
      </div>
      <div className="inspector-body">
        {images.length > 0 ? (
          <button
            type="button"
            className="phone-toggle"
            aria-pressed={phone}
            onClick={() => setPhone((on) => !on)}
          >
            {phone ? "Tamanho de painel" : "Tamanho de celular"}
          </button>
        ) : null}
        {images.length > 0 ? (
          <ul className={phone ? "slides phone" : "slides"} aria-label="Prévia por slide">
            {images.map((image, index) => (
              <li key={image.url} data-ratio={ratio}>
                {isVideo(image) ? (
                  // biome-ignore lint/a11y/useMediaCaption: narration captions are burnt into the Reel
                  <video
                    className="slide"
                    data-ratio={ratio}
                    src={image.url}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={`Vídeo ${index + 1} de ${images.length}`}
                  />
                ) : (
                  <img
                    className="slide"
                    data-ratio={ratio}
                    src={image.url}
                    alt={`Slide ${index + 1} de ${images.length}`}
                    loading={index === 0 ? "eager" : "lazy"}
                    decoding="async"
                  />
                )}
                {(() => {
                  const slot =
                    canRejectScene && item && !isVideo(image)
                      ? sceneSlotOf(item.slides, index, ratio === "9/16")
                      : null;
                  // Picking a reason sends this scene back alone; the rest of the package stays.
                  return slot ? (
                    <select
                      className="scene-reject"
                      aria-label={`Refazer a cena do slide ${index + 1}`}
                      disabled={busy !== null}
                      value=""
                      onChange={(event) =>
                        event.target.value && onRejectScene(slot, [event.target.value], "")
                      }
                    >
                      <option value="">Refazer cena…</option>
                      {SCENE_REASONS.map(([code, label]) => (
                        <option key={code} value={code}>
                          {label}
                        </option>
                      ))}
                    </select>
                  ) : null;
                })()}
              </li>
            ))}
          </ul>
        ) : (
          <AlertLine tone="wait">
            Ainda em produção: as imagens aparecem aqui quando ficarem prontas.
          </AlertLine>
        )}
        {item?.offer ? (
          <dl className="facts">
            <dt>Preço</dt>
            <dd>{item.offer.price ? formatMoney(item.offer.price) : "sem preço registrado"}</dd>
            <dt>Conferido</dt>
            <dd>
              {formatWhen(item.evidenceVerifiedAt)}
              {item.evidenceVerifiedAt && !evidenceFresh ? " (mais de 24h)" : ""}
            </dd>
          </dl>
        ) : null}
        {item?.caption ? <p className="caption">{item.caption}</p> : null}
        <dl className="facts">
          <dt>Canal</dt>
          <dd>{item?.channelLabel || variant.channelLabel || channelLabel(kind)}</dd>
          {niche ? (
            <>
              <dt>Nicho</dt>
              <dd>{niche}</dd>
            </>
          ) : null}
          {item?.offer ? (
            <>
              <dt>Oferta</dt>
              <dd>{item.offer.title}</dd>
            </>
          ) : item ? (
            <>
              <dt>Tipo</dt>
              <dd>Editorial, sem oferta</dd>
            </>
          ) : null}
          {item?.affiliateUrl ? (
            <>
              <dt>Link</dt>
              <dd>
                <a href={item.affiliateUrl} target="_blank" rel="noreferrer">
                  abrir no Mercado Livre <ExternalLink size={12} aria-hidden="true" />
                </a>
              </dd>
            </>
          ) : null}
          {item?.qa.render ? (
            <>
              <dt>Cenas</dt>
              <dd>{sceneStatusText(item.qa.render)}</dd>
              {item.qa.render.fidelity ? (
                <>
                  <dt>Produto fiel</dt>
                  <dd>
                    <Chip tone={verdictTone(item.qa.render.fidelity)}>
                      {verdictLabel(item.qa.render.fidelity)}
                    </Chip>
                  </dd>
                </>
              ) : null}
              {item.qa.render.quality ? (
                <>
                  <dt>Legibilidade</dt>
                  <dd>
                    <Chip tone={verdictTone(item.qa.render.quality)}>
                      {verdictLabel(item.qa.render.quality)}
                    </Chip>
                  </dd>
                </>
              ) : null}
              {item.qa.render.sequence && item.qa.render.sequence.length > 0 ? (
                <>
                  <dt>Sequência</dt>
                  <dd>{item.qa.render.sequence.join(", ")}</dd>
                </>
              ) : null}
            </>
          ) : null}
          {item?.qa.director && item.qa.director.findings.length > 0 ? (
            <>
              <dt>Diretor de QA</dt>
              <dd>
                <Chip tone={verdictTone(directorLevel(item.qa.director.level))}>
                  {verdictLabel(directorLevel(item.qa.director.level))}
                </Chip>{" "}
                {directorRepairs(item.qa.director).join("; ")}
              </dd>
            </>
          ) : null}
          {item?.qa.reel ? (
            <>
              <dt>QA do vídeo</dt>
              <dd>
                <Chip tone={verdictTone(item.qa.reel.verdict)}>
                  {verdictLabel(item.qa.reel.verdict)}
                </Chip>
                {item.qa.reel.checks.length > 0
                  ? ` ${item.qa.reel.checks.map((check) => checkLabel(check.id)).join(", ")}`
                  : ""}
              </dd>
            </>
          ) : null}
          {item &&
          item.slides.some(
            (slide) => slide.sceneLine || slide.voiceLine || slide.history.length > 0,
          ) ? (
            <>
              <dt>Plano</dt>
              <dd>
                <details>
                  <summary>Cena, narração e versões anteriores por slide</summary>
                  <ol className="plan">
                    {item.slides.map((slide) => (
                      <li key={slide.index}>
                        {slide.sceneLine ? (
                          <span>
                            Cena ({slide.sceneLineSource === "model" ? "diretor" : "padrão"}):{" "}
                            {slide.sceneLine}
                          </span>
                        ) : null}
                        {slide.voiceLine ? <span> Voz: {slide.voiceLine}</span> : null}
                        {slide.history.length > 0 ? (
                          <span className="versions">
                            {slide.history.map((version) => (
                              <img
                                key={version.url}
                                className="row-thumb"
                                src={version.url}
                                alt={`Tentativa ${version.attempt} (${version.canvas}): ${version.reasons.join(", ") || "sem motivo"}`}
                                title={`Tentativa ${version.attempt}: ${version.reasons.join(", ") || "sem motivo"}`}
                                loading="lazy"
                                decoding="async"
                              />
                            ))}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
              </dd>
            </>
          ) : null}
          {item?.policyMode ? (
            <>
              <dt>Política</dt>
              <dd>
                {item.policyMode === "manual"
                  ? "Publica só depois da sua aprovação"
                  : item.policyMode === "paused"
                    ? "Pausada: nada é publicado"
                    : "Publica dentro dos limites definidos"}
              </dd>
            </>
          ) : null}
        </dl>
        {error ? <AlertLine tone="bad">{error}</AlertLine> : null}
        {notice ? <AlertLine tone="ok">{notice}</AlertLine> : null}
      </div>
      <div className="inspector-foot">
        {canReview && returning ? (
          <>
            <fieldset className="reasons">
              <legend>Motivo</legend>
              {REVIEW_REASONS.map(([code, label]) => (
                <button
                  key={code}
                  type="button"
                  className="btn btn-outline"
                  aria-pressed={codes.includes(code)}
                  onClick={() => toggleCode(code)}
                >
                  {label}
                </button>
              ))}
            </fieldset>
            <label className="note">
              O que precisa mudar?
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
              />
            </label>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setReturning(false)}
              disabled={busy !== null}
            >
              Voltar
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => onReject(rejectionText(codes, reason))}
              disabled={busy !== null || rejectionText(codes, reason).length === 0}
            >
              <Undo2 aria-hidden="true" />
              {busy === "reject" ? "Devolvendo…" : "Devolver"}
            </button>
          </>
        ) : canReview ? (
          <>
            <button
              type="button"
              className="btn btn-outline"
              onClick={() => setReturning(true)}
              disabled={busy !== null}
            >
              <Undo2 aria-hidden="true" />
              Devolver
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onApprove}
              disabled={busy !== null}
            >
              <Check aria-hidden="true" />
              {busy === "approve" ? "Aprovando…" : "Aprovar"}
            </button>
          </>
        ) : canPublish ? (
          <>
            <p className="inspector-note">Aprovado. Publique quando quiser.</p>
            <button
              type="button"
              className="btn btn-primary"
              style={{ gridColumn: "1 / -1" }}
              onClick={onPublish}
              disabled={busy !== null}
            >
              <Send aria-hidden="true" />
              {busy === "publish" ? "Publicando…" : "Publicar agora"}
            </button>
          </>
        ) : (
          <p className="inspector-note">
            {variant.state === "approved"
              ? "Aprovado. Um operador pode publicar."
              : variant.state === "published"
                ? "Publicado. Os resultados aparecem em Resultados."
                : variant.state === "rejected"
                  ? "Devolvido para ajustes no ChatGPT."
                  : "Nada a fazer aqui por enquanto."}
          </p>
        )}
      </div>
    </aside>
  );
};

/** The desk itself: rail, rows, inspector, and the approve-then-move moment. */
const FailedRow = ({
  job,
  workspaceId,
  client,
  onRetried,
}: Readonly<{
  job: FailedJobEntry;
  workspaceId: string;
  client: PanelClient;
  onRetried: () => void;
}>) => {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const retry = async () => {
    setBusy(true);
    setOutcome(null);
    const result = await client.retryJob(workspaceId, job.jobId);
    setBusy(false);
    if (!result.ok) return setOutcome({ ok: false, message: result.message ?? "Algo deu errado." });
    setOutcome({ ok: true, message: "Voltou para a fila" });
    window.setTimeout(onRetried, 1200);
  };
  return (
    <li>
      <div className="row" style={{ cursor: "default", flexWrap: "wrap" }}>
        <span className="row-body">
          <span className="row-title">{packageTitle(job.title)}</span>
          <span className="row-meta">
            <Chip>{failedStepLabel(job.name)}</Chip>
            <small>{failedReasonText(job.reason)}</small>
            <span>{relativeWhen(job.at)}</span>
          </span>
        </span>
        <span className="row-actions">
          <button
            type="button"
            className="btn btn-outline btn-sm"
            disabled={busy || outcome?.ok === true}
            onClick={() => void retry()}
          >
            {busy ? "Refazendo…" : "Refazer pacote"}
          </button>
        </span>
      </div>
      {outcome ? <AlertLine tone={outcome.ok ? "ok" : "bad"}>{outcome.message}</AlertLine> : null}
    </li>
  );
};

const FailedPackages = ({
  workspaceId,
  client,
}: Readonly<{ workspaceId: string; client: PanelClient }>) => {
  const [jobs, setJobs] = useState<FailedJobEntry[]>([]);
  useEffect(() => {
    let live = true;
    void client.failedJobs(workspaceId).then((loaded) => live && setJobs(loaded));
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  if (jobs.length === 0) return null;
  return (
    <section className="failed">
      <h2>Precisa de você: refazer pacote</h2>
      <p>Clique em "Refazer pacote". O resto é automático.</p>
      <ul className="rows" aria-label="Pacotes com falha">
        {jobs.map((job) => (
          <FailedRow
            key={job.jobId}
            job={job}
            workspaceId={workspaceId}
            client={client}
            onRetried={() => setJobs((current) => current.filter((j) => j.jobId !== job.jobId))}
          />
        ))}
      </ul>
    </section>
  );
};

export const ReviewDesk = ({
  data,
  workspaceId,
  role,
  client,
  onChanged,
  title = "Revisar",
  initialStage = "review",
}: ReviewDeskProps) => {
  const [stage, setStage] = useState<StageKey>(initialStage);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [seal, setSeal] = useState<Seal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const measured = useMemo(() => measuredIds(data), [data]);
  const rows = useMemo(
    () => data.variants.filter((variant) => stageOf(variant, measured) === stage),
    [data, measured, stage],
  );
  const selected = data.variants.find(({ id }) => id === selectedId) ?? null;
  const item = data.reviewQueue.find(({ id }) => id === selectedId) ?? null;

  const run = async (
    kind: Exclude<Busy, null>,
    action: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    if (!selected) return;
    setBusy(kind);
    setError(null);
    setNotice(null);
    const result = await action();
    if (!result.ok) {
      setError(result.message ?? "Algo deu errado.");
      setBusy(null);
      return;
    }
    if (kind === "approve" || kind === "reject") {
      // Stamp the ticket, let the seal land, then tear the row off the roll.
      setSeal({ kind, at: sealTime() });
      await new Promise((resolve) => window.setTimeout(resolve, 520));
      setLeavingId(selected.id);
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      setSeal(null);
    }
    await onChanged();
    setLeavingId(null);
    setBusy(null);
    if (kind === "approve") {
      setStage("approved");
      setLandedId(selected.id);
      window.setTimeout(() => setLandedId(null), 950);
      setNotice("Aprovado. Publique quando quiser.");
    } else if (kind === "reject") {
      setSelectedId(null);
    } else if (kind === "scene") {
      setNotice("Cena devolvida: só ela será redesenhada e o pacote volta para revisão.");
    } else {
      setNotice("Publicação pedida. Acompanhe em Conteúdos.");
    }
  };

  return (
    <>
      <DeskTitle
        title={title}
        hint={
          rows.length === 0 && stage === "review"
            ? "Nada esperando por você."
            : `${rows.length} ${rows.length === 1 ? "item" : "itens"} nesta etapa`
        }
      />
      <StageRail
        data={data}
        current={stage}
        onSelect={(next) => {
          setStage(next);
          setSelectedId(null);
        }}
      />
      {initialStage === "review" && role !== "reviewer" ? (
        <FailedPackages workspaceId={workspaceId} client={client} />
      ) : null}
      <div className={selected ? "desk-split" : undefined}>
        {rows.length === 0 ? (
          <Empty
            title={
              stage === "review"
                ? "Nada para aprovar"
                : stage === "draft"
                  ? "Nada em produção"
                  : stage === "approved"
                    ? "Nada aprovado esperando publicação"
                    : stage === "published"
                      ? "Nada publicado ainda"
                      : "Nenhum resultado medido ainda"
            }
          >
            <p>
              {stage === "review"
                ? "Nada para aprovar agora. Cada pacote aparece aqui quando a fábrica termina, com prévia e os botões aprovar ou rejeitar."
                : stage === "measured"
                  ? "Depois de publicar, as métricas chegam e o conteúdo passa para esta etapa."
                  : "Conteúdos mudam de etapa conforme você aprova e publica."}
            </p>
          </Empty>
        ) : (
          <ul className="rows" aria-label="Conteúdos">
            {rows.map((variant) => (
              <VariantRow
                key={variant.id}
                variant={variant}
                data={data}
                selected={variant.id === selectedId}
                leaving={variant.id === leavingId}
                landed={variant.id === landedId}
                onOpen={() => {
                  setSelectedId(variant.id);
                  setError(null);
                  setNotice(null);
                }}
              />
            ))}
          </ul>
        )}
        {selected ? (
          <Inspector
            key={selected.id}
            item={item}
            variant={selected}
            data={data}
            role={role}
            busy={busy}
            seal={seal}
            error={error}
            notice={notice}
            onClose={() => setSelectedId(null)}
            onApprove={() => void run("approve", () => client.approve(workspaceId, selected.id))}
            onReject={(reason) =>
              void run("reject", () => client.reject(workspaceId, selected.id, reason))
            }
            onRejectScene={(slot, reasons, note) =>
              void run("scene", () =>
                client.rejectScene(workspaceId, selected.contentItemId, slot, reasons, note),
              )
            }
            onPublish={() => void run("publish", () => client.publish(workspaceId, selected.id))}
          />
        ) : null}
      </div>
    </>
  );
};
