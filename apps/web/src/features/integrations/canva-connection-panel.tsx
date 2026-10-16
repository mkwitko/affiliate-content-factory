import { useCallback, useEffect, useState } from "react";
import { Chip } from "../panel/desk.js";

type CanvaConnectionPanelProps = Readonly<{
  workspaceId?: string;
  role: "owner" | "operator" | "reviewer";
  request?: typeof fetch;
}>;

type Connection = Readonly<{
  id: string;
  provider: string;
  status: string;
  accountId: string;
  displayName?: string | null;
}>;

export const CanvaConnectionPanel = ({
  workspaceId,
  role,
  request = fetch,
}: CanvaConnectionPanelProps) => {
  const canManage = role === "owner" || role === "operator";
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(false);
  const [justConnected] = useState(
    () => new URLSearchParams(window.location.search).get("canva_connected") === "1",
  );
  // Show the success message once; drop the flag so a reload does not repeat it.
  useEffect(() => {
    if (!justConnected) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("canva_connected");
    window.history.replaceState(window.history.state, "", url);
  }, [justConnected]);

  const load = useCallback(async (): Promise<void> => {
    if (!workspaceId) return;
    const response = await request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections`,
      { credentials: "include" },
    );
    if (!response.ok) {
      setError(true);
      return;
    }
    const body = (await response.json()) as { connections?: Connection[] };
    setConnection(
      (body.connections ?? []).find(
        (candidate) => candidate.provider === "canva" && candidate.status === "active",
      ) ?? null,
    );
    setLoaded(true);
  }, [request, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = (): void => {
    if (!workspaceId) return;
    window.location.href = `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/canva/connect`;
  };

  const disconnect = async (): Promise<void> => {
    if (!workspaceId || !connection) return;
    if (!window.confirm("Desconectar o Canva? A exportação de designs será interrompida.")) return;
    setDisconnecting(true);
    try {
      const response = await request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/${encodeURIComponent(connection.id)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok) throw new Error("disconnect_failed");
      setConnection(null);
    } catch {
      setError(true);
    } finally {
      setDisconnecting(false);
    }
  };

  if (!workspaceId) return null;

  return (
    <section className="slip" aria-labelledby="canva-title">
      <h2 id="canva-title">Canva</h2>
      <p className="hint">
        Conecte sua conta do Canva para exportar designs como imagens de conteúdo.
      </p>
      {justConnected ? (
        <p className="alert-line" data-tone="ok" role="status">
          Conta do Canva conectada com sucesso!
        </p>
      ) : null}
      {!loaded ? (
        <p className="alert-line" data-tone="quiet">
          Carregando status da conexão…
        </p>
      ) : null}
      {loaded && connection ? (
        <>
          <dl className="facts">
            <dt>Conta do Canva: {connection.displayName ?? connection.accountId}</dt>
            <dd>
              <Chip tone="ok">Conectada</Chip>
            </dd>
          </dl>
          {canManage ? (
            <div className="actions">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                data-action="disconnect-canva"
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                {disconnecting ? "Desconectando" : "Desconectar"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {loaded && !connection && canManage ? (
        <div className="actions">
          <button
            type="button"
            className="btn btn-primary"
            data-action="connect-canva"
            onClick={connect}
          >
            Conectar Canva
          </button>
        </div>
      ) : null}
      {loaded && !connection && !canManage ? (
        <p className="hint">Somente proprietários e operadores podem conectar o Canva.</p>
      ) : null}
      {error ? (
        <p className="alert-line" data-tone="bad" role="alert">
          Não foi possível atualizar esta conexão. Tente novamente.
        </p>
      ) : null}
    </section>
  );
};
