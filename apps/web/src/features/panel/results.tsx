import { ExternalLink } from "lucide-react";
import { AlertLine, DeskTitle, Empty } from "./desk.js";
import { channelLabel, formatCount, formatWhen, type PanelData } from "./panel-data.js";

type ResultsDeskProps = Readonly<{ data: PanelData }>;

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** Every bar measures against the same ruler: the largest value on the page. */
const Bars = ({
  title,
  rows,
}: Readonly<{
  title: string;
  rows: readonly Readonly<{ label: string; value: number; href?: string | null }>[];
}>) => {
  const max = Math.max(1, ...rows.map(({ value }) => value));
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section aria-labelledby={`bars-${slug}`}>
      <h2 id={`bars-${slug}`}>{title}</h2>
      <div className="rows">
        {rows.map((row) => (
          <div className="bar" key={row.label}>
            <span>
              {row.href ? (
                <a href={row.href} target="_blank" rel="noreferrer">
                  <span>{row.label}</span>
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                row.label
              )}
            </span>
            <i style={{ width: `${(row.value / max) * 100}%` }} aria-hidden="true" />
            <em>{formatCount(row.value)}</em>
          </div>
        ))}
      </div>
    </section>
  );
};

export const ResultsDesk = ({ data }: ResultsDeskProps) => {
  const posts = data.performance?.posts ?? [];
  const clicks = data.attribution?.totalClicks ?? sum(posts.map(({ clicks: value }) => value));
  const views = sum(posts.map(({ metrics }) => metrics.views ?? 0));
  const reach = sum(posts.map(({ metrics }) => metrics.reach ?? 0));
  const lastClick = data.attribution?.rows
    .map(({ lastClickAt }) => lastClickAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);

  const nicheRows = (data.attribution?.rows ?? [])
    .map((row) => ({
      label:
        data.niches.find(({ id, slug }) => id === row.key || slug === row.key)?.name ?? row.key,
      value: row.clicks,
    }))
    .sort((a, b) => b.value - a.value);

  const postRows = posts
    .map((post) => {
      const variant = data.variants.find(({ id }) => id === post.contentVariantId);
      return {
        label: `${variant?.title || "Conteúdo"} · ${variant?.channelLabel || channelLabel(variant?.channelKind ?? null)}`,
        value: post.clicks,
        href: post.platformUrl,
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 12);

  if (data.attribution === null && data.performance === null) {
    return (
      <>
        <DeskTitle title="Resultados" />
        <AlertLine tone="wait">
          A medição ainda não está ligada neste espaço. Publique um conteúdo com link rastreado e os
          cliques passam a aparecer aqui.
        </AlertLine>
      </>
    );
  }

  return (
    <>
      <DeskTitle
        title="Resultados"
        hint={[
          `${formatCount(clicks)} cliques em ${formatCount(posts.length)} ${posts.length === 1 ? "conteúdo" : "conteúdos"}`,
          views > 0 ? `${formatCount(views)} visualizações` : null,
          reach > 0 ? `${formatCount(reach)} de alcance` : null,
          lastClick ? `último clique ${formatWhen(lastClick)}` : "nenhum clique registrado",
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      <AlertLine tone="quiet">
        Receita atribuída aparece quando o Mercado Livre confirma vendas pelo link. Até lá, o painel
        mostra só o que foi medido.
      </AlertLine>
      {postRows.length > 0 ? (
        <Bars title="Cliques por conteúdo" rows={postRows} />
      ) : (
        <Empty title="Nenhum conteúdo medido ainda">
          <p>
            Depois de publicar, cada conteúdo aparece aqui com cliques, visualizações e alcance.
          </p>
        </Empty>
      )}
      {nicheRows.length > 0 ? <Bars title="Cliques por nicho" rows={nicheRows} /> : null}
    </>
  );
};
