import { CheckCircle2, Circle, ClipboardCheck, Link2, type LucideIcon, Plug } from "lucide-react";
import type { ReactNode } from "react";
import type { PanelSection } from "../../routes/route-parser.js";
import type { Tone } from "./panel-data.js";

/**
 * Three doors: the owner's two jobs (approve, paste links) and the accounts behind them.
 * Conteúdos, Ofertas, Nichos and Resultados keep their URLs but leave the nav (owner, 2026-10-15).
 */
export const sectionMeta: readonly Readonly<{
  section: PanelSection;
  label: string;
  tab: string;
  icon: LucideIcon;
}>[] = [
  { section: "revisar", label: "Aprovar", tab: "Aprovar", icon: ClipboardCheck },
  { section: "links", label: "Links", tab: "Links", icon: Link2 },
  { section: "integracoes", label: "Contas", tab: "Contas", icon: Plug },
];

export const sectionHref = (section: PanelSection): string => {
  const url = new URL(window.location.href);
  url.pathname = section === "revisar" ? "/" : `/${section}`;
  return `${url.pathname}${url.search}`;
};

type DeskNavProps = Readonly<{ section: PanelSection; pending: number; linksPending: number }>;

const links = ({ section, pending, linksPending }: DeskNavProps, compact = false) =>
  sectionMeta.map(({ section: key, label, tab, icon: Icon }) => (
    <a
      key={key}
      className="desk-link"
      href={sectionHref(key)}
      aria-current={key === section ? "page" : undefined}
    >
      <Icon aria-hidden="true" />
      <span>{compact ? tab : label}</span>
      {key === "revisar" && pending > 0 ? (
        <b>
          {pending}
          <span className="sr-only"> para revisar</span>
        </b>
      ) : null}
      {key === "links" && linksPending > 0 ? (
        <b>
          {linksPending}
          <span className="sr-only"> esperando link</span>
        </b>
      ) : null}
    </a>
  ));

/** Desktop rail and mobile tab bar share the same three doors. */
export const DeskNav = (props: DeskNavProps) => (
  <nav className="desk-nav" aria-label="Seções">
    {links(props)}
  </nav>
);

export const DeskTabs = (props: DeskNavProps) => (
  <nav className="desk-tabs" aria-label="Seções">
    {links(props, true)}
  </nav>
);

export const Chip = ({
  tone = "quiet",
  children,
}: Readonly<{ tone?: Tone; children: ReactNode }>) => (
  <span className="chip" data-tone={tone}>
    {children}
  </span>
);

export const AlertLine = ({ tone, children }: Readonly<{ tone: Tone; children: ReactNode }>) => (
  <p className="alert-line" data-tone={tone} role={tone === "bad" ? "alert" : "status"}>
    {children}
  </p>
);

export const Empty = ({ title, children }: Readonly<{ title: string; children?: ReactNode }>) => (
  <div className="empty">
    <h2>{title}</h2>
    {children}
  </div>
);

const printedAt = (): string =>
  new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date())
    .replace(/\./g, "");

/** Receipt header: dupla title, then the hint and the moment this roll was printed. */
export const DeskTitle = ({ title, hint }: Readonly<{ title: string; hint?: string }>) => (
  <div className="desk-title">
    <h1>{title}</h1>
    <p>
      <span>{hint}</span>
      <time>{printedAt()}</time>
    </p>
  </div>
);

const SKELETON_ROWS = ["a", "b", "c", "d"];

export const RowsSkeleton = () => (
  <ul className="rows" aria-busy="true" aria-label="Carregando">
    {SKELETON_ROWS.map((key) => (
      <li key={key}>
        <div className="row" aria-hidden="true">
          <div className="skeleton row-thumb" />
          <div className="row-body">
            <div className="skeleton" style={{ height: 14, width: "70%" }} />
            <div className="skeleton" style={{ height: 12, width: "40%" }} />
          </div>
          <div className="skeleton" style={{ height: 22, width: 72 }} />
        </div>
      </li>
    ))}
  </ul>
);

export const DoneIcon = ({ done }: Readonly<{ done: boolean }>) =>
  done ? <CheckCircle2 aria-hidden="true" /> : <Circle aria-hidden="true" />;
