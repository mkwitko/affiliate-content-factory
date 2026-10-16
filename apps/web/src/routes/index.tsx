import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  useSelectedWorkspaceId,
  useSelectedWorkspaceRole,
} from "../features/auth/authenticated-shell.js";
import { CanvaConnectionPanel } from "../features/integrations/canva-connection-panel.js";
import { MercadoLivreConnectionPanel } from "../features/integrations/mercado-livre-connection-panel.js";
import { ProviderConnectionPanel } from "../features/integrations/provider-connection-panel.js";
import {
  AlertLine,
  Chip,
  DeskNav,
  DeskTabs,
  DeskTitle,
  RowsSkeleton,
} from "../features/panel/desk.js";
import { InboxDesk } from "../features/panel/inbox.js";
import { LinksDesk } from "../features/panel/links.js";
import { NichesDesk } from "../features/panel/niches.js";
import { OffersDesk } from "../features/panel/offers.js";
import {
  createPanelClient,
  type LinkQueue,
  type PanelClient,
  type PanelData,
  providerLabel,
} from "../features/panel/panel-data.js";
import { ResultsDesk } from "../features/panel/results.js";
import { ReviewDesk } from "../features/panel/review.js";
import type { PanelSection } from "./route-parser.js";

type HomeRouteProps = Readonly<{ section?: PanelSection; client?: PanelClient }>;

type LoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; data: PanelData }>;

const Integrations = ({ data, role }: Readonly<{ data: PanelData | null; role: string }>) => {
  const workspaceId = useSelectedWorkspaceId();
  const props = {
    ...(workspaceId ? { workspaceId } : {}),
    role: (role || "reviewer") as "owner" | "operator" | "reviewer",
  };
  return (
    <>
      <DeskTitle
        title="Contas"
        hint="Instagram e TikTok (Post For Me), Mercado Livre e Canva. Chaves ficam aqui, nunca no chat."
      />
      {data && data.connections.length > 0 ? (
        <dl className="facts">
          {[...new Set(data.connections.map(({ provider }) => provider))].map((provider) => {
            const active = data.connections.some(
              (connection) => connection.provider === provider && connection.status === "active",
            );
            return (
              <Fragment key={provider}>
                <dt>{providerLabel(provider)}</dt>
                <dd>
                  <Chip tone={active ? "ok" : "wait"}>
                    {active ? "Conectado" : "Não conectado"}
                  </Chip>
                </dd>
              </Fragment>
            );
          })}
        </dl>
      ) : null}
      <ProviderConnectionPanel {...props} />
      <MercadoLivreConnectionPanel {...props} />
      <CanvaConnectionPanel {...props} />
    </>
  );
};

// The desk: one data load per workspace. The nav shows Aprovar, Links and Contas; the other
// sections stay reachable by URL.
export const HomeRoute = ({ section = "revisar", client: givenClient }: HomeRouteProps) => {
  const workspaceId = useSelectedWorkspaceId();
  const role = useSelectedWorkspaceRole() ?? "reviewer";
  const client = useMemo(() => givenClient ?? createPanelClient(), [givenClient]);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [queue, setQueue] = useState<LinkQueue | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId) return setState({ status: "error" });
    void client.linkQueue(workspaceId).then(setQueue);
    try {
      const data = await client.load(workspaceId);
      setState(data ? { status: "ready", data } : { status: "error" });
    } catch {
      setState({ status: "error" });
    }
  }, [client, workspaceId]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  const data = state.status === "ready" ? state.data : null;
  const pending =
    data?.variants.filter(({ state: value }) => value === "ready_for_review").length ?? 0;

  const body = () => {
    if (section === "integracoes") return <Integrations data={data} role={role} />;
    if (state.status === "loading")
      return (
        <>
          <DeskTitle title="Carregando a mesa…" />
          <RowsSkeleton />
        </>
      );
    if (state.status === "error" || !workspaceId || !data)
      return (
        <>
          <DeskTitle title="Não deu para carregar" />
          <AlertLine tone="bad">
            O servidor não respondeu. Confira a conexão e tente de novo.
          </AlertLine>
          <button type="button" className="btn btn-outline" onClick={() => void load()}>
            Tentar de novo
          </button>
        </>
      );
    const shared = { data, workspaceId, role, client, onChanged: load };
    switch (section) {
      case "conteudos":
        return <ReviewDesk {...shared} title="Conteúdos" initialStage="published" />;
      case "links":
        return <LinksDesk {...shared} queue={queue} />;
      case "ofertas":
        return <OffersDesk {...shared} />;
      case "nichos":
        return <NichesDesk {...shared} />;
      case "resultados":
        return <ResultsDesk data={data} />;
      default:
        return <InboxDesk {...shared} />;
    }
  };

  return (
    <div className="desk-body">
      <DeskNav section={section} pending={pending} linksPending={queue?.total ?? 0} />
      <main className="desk-main" aria-live="polite">
        <div className="roll">{body()}</div>
      </main>
      <DeskTabs section={section} pending={pending} linksPending={queue?.total ?? 0} />
    </div>
  );
};
