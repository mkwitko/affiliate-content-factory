import { ArrowLeft, Check, ExternalLink, ImageOff, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import { AlertLine, DeskTitle, Empty } from "./desk.js";
import {
  channelLabel,
  channelRatio,
  formatMoney,
  formatWhen,
  isFresh,
  isVideo,
  type PanelClient,
  type PanelData,
  type PanelImage,
  type PanelReviewItem,
  type PanelVariant,
  stageOf,
  verdictLabel,
} from "./panel-data.js";
import { measuredIds } from "./review.js";

/**
 * The inbox: one ticket per package. The owner sees the video and the slides, then stamps the
 * whole package APROVAR or DEVOLVER; every rendered format of the package follows that stamp.
 */
export type ReviewPackage = Readonly<{
  contentItemId: string;
  title: string;
  nicheId: string | null;
  /** Rendered formats waiting for the stamp. */
  variants: readonly PanelVariant[];
  items: readonly PanelReviewItem[];
  /** Formats of the same package still being produced. */
  inProduction: number;
}>;

export const packagesOf = (data: PanelData): readonly ReviewPackage[] => {
  const measured = measuredIds(data);
  const groups = new Map<string, PanelVariant[]>();
  for (const variant of data.variants) {
    if (stageOf(variant, measured) !== "review") continue;
    groups.set(variant.contentItemId, [...(groups.get(variant.contentItemId) ?? []), variant]);
  }
  return [...groups].map(([contentItemId, variants]) => ({
    contentItemId,
    title: variants[0]?.title ?? "",
    nicheId: variants[0]?.nicheId ?? null,
    variants,
    items: data.reviewQueue.filter((item) => item.contentItemId === contentItemId),
    inProduction: data.variants.filter(
      (variant) =>
        variant.contentItemId === contentItemId && stageOf(variant, measured) === "draft",
    ).length,
  }));
};

/** The Reel when one exists, then the carousel's slides; other formats repeat the same media. */
export const mediaOf = (
  pkg: ReviewPackage,
): Readonly<{ video: PanelImage | null; slides: readonly PanelImage[]; ratio: "4/5" | "9/16" }> => {
  const images = pkg.items.flatMap((item) => item.images);
  const video = images.find(isVideo) ?? null;
  const carousel =
    pkg.items.find(
      (item) => item.channelKind === "instagram_carousel" && item.images.some((i) => !isVideo(i)),
    ) ?? pkg.items.find((item) => item.images.some((image) => !isVideo(image)));
  const slides = carousel?.images.filter((image) => !isVideo(image)) ?? [];
  return {
    video,
    slides,
    ratio: channelRatio(carousel?.channelKind ?? null) === "9/16" ? "9/16" : "4/5",
  };
};

/** QA verdicts that are not a pass, worded once each; empty when the package is clean. */
export const warningsOf = (pkg: ReviewPackage): readonly string[] => [
  ...new Set(
    pkg.items.flatMap((item) =>
      [
        item.qa.render?.fidelity ? ["produto", item.qa.render.fidelity] : null,
        item.qa.render?.quality ? ["legibilidade", item.qa.render.quality] : null,
        item.qa.reel ? ["vídeo", item.qa.reel.verdict] : null,
      ]
        .filter((entry): entry is [string, string] => entry !== null && entry[1] !== "pass")
        .map(([what, verdict]) => `${what}: ${verdictLabel(verdict)}`),
    ),
  ),
];

const sealTime = (): string =>
  new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());

type Seal = Readonly<{ kind: "approve" | "reject"; at: string }>;
type Busy = "approve" | "reject" | null;

const Thumb = ({ url }: Readonly<{ url: string | null }>) =>
  url ? (
    <img className="row-thumb" src={url} alt="" loading="lazy" decoding="async" />
  ) : (
    <span className="row-thumb" aria-hidden="true">
      <ImageOff size={18} />
    </span>
  );

const PackageRow = ({
  pkg,
  niche,
  selected,
  leaving,
  onOpen,
}: Readonly<{
  pkg: ReviewPackage;
  niche: string | null;
  selected: boolean;
  leaving: boolean;
  onOpen: () => void;
}>) => {
  const price = pkg.items.find((item) => item.offer?.price)?.offer?.price ?? null;
  const formats = pkg.variants.map((variant) => channelLabel(variant.channelKind)).join(" · ");
  return (
    <li>
      <button
        type="button"
        className="row"
        aria-pressed={selected}
        data-leaving={leaving ? "true" : undefined}
        onClick={onOpen}
      >
        <Thumb url={pkg.variants.find((variant) => variant.thumbnailUrl)?.thumbnailUrl ?? null} />
        <span className="row-body">
          <span className="row-title">{pkg.title || "Sem título"}</span>
          <span className="row-meta">
            {niche ? <strong>{niche}</strong> : null}
            {price ? <span>{formatMoney(price)}</span> : null}
            <span>{formats}</span>
          </span>
        </span>
      </button>
    </li>
  );
};

const Ticket = ({
  pkg,
  niche,
  busy,
  seal,
  error,
  onClose,
  onApprove,
  onReject,
}: Readonly<{
  pkg: ReviewPackage;
  niche: string | null;
  busy: Busy;
  seal: Seal | null;
  error: string | null;
  onClose: () => void;
  onApprove: () => void;
  onReject: (reason: string) => void;
}>) => {
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState("");
  const { video, slides, ratio } = mediaOf(pkg);
  const lead = pkg.items.find((item) => item.offer) ?? pkg.items[0] ?? null;
  const warnings = warningsOf(pkg);
  const evidence = lead?.evidenceVerifiedAt ?? null;
  return (
    <aside className="inspector" aria-labelledby="ticket-title">
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
        <h2 id="ticket-title">{pkg.title || "Sem título"}</h2>
      </div>
      <div className="inspector-body">
        {video ? (
          // biome-ignore lint/a11y/useMediaCaption: narration captions are burnt into the Reel
          <video
            className="ticket-video"
            src={video.url}
            controls
            playsInline
            preload="metadata"
            aria-label="Vídeo do pacote"
          />
        ) : null}
        {slides.length > 0 ? (
          <ul className="slides" aria-label="Slides">
            {slides.map((image, index) => (
              <li key={image.url} data-ratio={ratio}>
                <img
                  className="slide"
                  data-ratio={ratio}
                  src={image.url}
                  alt={`Slide ${index + 1} de ${slides.length}`}
                  loading={index === 0 ? "eager" : "lazy"}
                  decoding="async"
                />
              </li>
            ))}
          </ul>
        ) : null}
        {!video && slides.length === 0 ? (
          <AlertLine tone="wait">As imagens aparecem aqui quando ficarem prontas.</AlertLine>
        ) : null}
        {warnings.length > 0 ? (
          <AlertLine tone="review">Conferir: {warnings.join(", ")}.</AlertLine>
        ) : null}
        {lead?.caption ? <p className="caption">{lead.caption}</p> : null}
        <dl className="facts">
          {lead?.offer ? (
            <>
              <dt>Preço</dt>
              <dd>
                {lead.offer.price ? formatMoney(lead.offer.price) : "sem preço registrado"}
                {evidence ? ` · conferido ${formatWhen(evidence)}` : ""}
                {evidence && !isFresh(evidence) ? " (mais de 24h)" : ""}
              </dd>
            </>
          ) : null}
          {niche ? (
            <>
              <dt>Perfil</dt>
              <dd>{niche}</dd>
            </>
          ) : null}
          <dt>Formatos</dt>
          <dd>
            {pkg.variants.map((variant) => channelLabel(variant.channelKind)).join(", ")}
            {pkg.inProduction > 0 ? ` (+${pkg.inProduction} em produção)` : ""}
          </dd>
          {lead?.affiliateUrl ? (
            <>
              <dt>Link</dt>
              <dd>
                <a href={lead.affiliateUrl} target="_blank" rel="noreferrer">
                  abrir no Mercado Livre <ExternalLink size={12} aria-hidden="true" />
                </a>
              </dd>
            </>
          ) : null}
        </dl>
        {error ? <AlertLine tone="bad">{error}</AlertLine> : null}
      </div>
      <div className="inspector-foot">
        {returning ? (
          <>
            <label className="note">
              O que está errado?
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
              onClick={() => onReject(reason.trim())}
              disabled={busy !== null || reason.trim().length === 0}
            >
              <Undo2 aria-hidden="true" />
              {busy === "reject" ? "Devolvendo…" : "Devolver"}
            </button>
          </>
        ) : (
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
        )}
      </div>
    </aside>
  );
};

type InboxDeskProps = Readonly<{
  data: PanelData;
  workspaceId: string;
  client: PanelClient;
  onChanged: () => Promise<void>;
}>;

export const InboxDesk = ({ data, workspaceId, client, onChanged }: InboxDeskProps) => {
  const packages = useMemo(() => packagesOf(data), [data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [seal, setSeal] = useState<Seal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = packages.find((pkg) => pkg.contentItemId === selectedId) ?? null;
  const nicheName = (nicheId: string | null) =>
    data.niches.find(({ id }) => id === nicheId)?.name ?? null;
  const measured = useMemo(() => measuredIds(data), [data]);
  const producing = data.variants.filter((v) => stageOf(v, measured) === "draft").length;
  const approved = data.variants.filter((v) => stageOf(v, measured) === "approved").length;

  // One stamp covers every rendered format; the first failure stops and names itself.
  const stamp = async (
    kind: Exclude<Busy, null>,
    action: (variant: PanelVariant) => Promise<{ ok: boolean; message?: string }>,
  ) => {
    if (!selected) return;
    setBusy(kind);
    setError(null);
    for (const variant of selected.variants) {
      const result = await action(variant);
      if (!result.ok) {
        setError(result.message ?? "Algo deu errado.");
        setBusy(null);
        return;
      }
    }
    setSeal({ kind, at: sealTime() });
    await new Promise((resolve) => window.setTimeout(resolve, 520));
    setLeavingId(selected.contentItemId);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    setSeal(null);
    await onChanged();
    setLeavingId(null);
    setBusy(null);
    setSelectedId(null);
  };

  return (
    <>
      <DeskTitle
        title="Aprovar"
        hint={
          packages.length === 0
            ? "Nada esperando por você."
            : `${packages.length} ${packages.length === 1 ? "pacote" : "pacotes"} para aprovar`
        }
      />
      <div className={selected ? "desk-split" : undefined}>
        {packages.length === 0 ? (
          <Empty title="Nada para aprovar">
            <p>Cada pacote aparece aqui pronto, com vídeo e slides. Você só aprova ou devolve.</p>
          </Empty>
        ) : (
          <ul className="rows" aria-label="Pacotes">
            {packages.map((pkg) => (
              <PackageRow
                key={pkg.contentItemId}
                pkg={pkg}
                niche={nicheName(pkg.nicheId)}
                selected={pkg.contentItemId === selectedId}
                leaving={pkg.contentItemId === leavingId}
                onOpen={() => {
                  setSelectedId(pkg.contentItemId);
                  setError(null);
                }}
              />
            ))}
          </ul>
        )}
        {selected ? (
          <Ticket
            key={selected.contentItemId}
            pkg={selected}
            niche={nicheName(selected.nicheId)}
            busy={busy}
            seal={seal}
            error={error}
            onClose={() => setSelectedId(null)}
            onApprove={() => void stamp("approve", (v) => client.approve(workspaceId, v.id))}
            onReject={(reason) =>
              void stamp("reject", (v) => client.reject(workspaceId, v.id, reason))
            }
          />
        ) : null}
      </div>
      <p className="roll-note">
        {producing > 0 ? `${producing} em produção` : "Nada em produção"}
        {approved > 0 ? ` · ${approved} aprovados` : ""}
        {" · "}
        <a href="/conteudos">histórico</a>
      </p>
    </>
  );
};
