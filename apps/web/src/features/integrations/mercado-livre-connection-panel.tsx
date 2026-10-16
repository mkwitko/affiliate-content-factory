import { useCallback, useEffect, useState } from "react";
import { Chip } from "../panel/desk.js";
import { formatCheckedAt, testReasonLabel } from "./connection-test-reason.js";

type TestOutcome =
  | Readonly<{ ok: true; account: string; checkedAt: string }>
  | Readonly<{ ok: false; reason: string; checkedAt: string }>;

const REDIRECT_URI = "https://example.com/v1/integrations/mercado-livre/callback";

type MercadoLivreConnectionPanelProps = Readonly<{
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

export const MercadoLivreConnectionPanel = ({
  workspaceId,
  role,
  request = fetch,
}: MercadoLivreConnectionPanelProps) => {
  const canManage = role === "owner" || role === "operator";
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [testing, setTesting] = useState(false);
  const [justConnected] = useState(
    () => new URLSearchParams(window.location.search).get("mercado_livre_connected") === "1",
  );
  // Show the success message once; drop the flag so a reload does not repeat it.
  useEffect(() => {
    if (!justConnected) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("mercado_livre_connected");
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
        (candidate) => candidate.provider === "mercado_livre" && candidate.status === "active",
      ) ?? null,
    );
    setLoaded(true);
  }, [request, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveCredentialsAndConnect = async (): Promise<void> => {
    if (!workspaceId || !appId.trim() || !appSecret.trim()) return;
    setSavingCredentials(true);
    setError(false);
    try {
      const response = await request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/mercado-livre/credentials`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appId: appId.trim(), appSecret: appSecret.trim() }),
        },
      );
      if (!response.ok) throw new Error("credentials_save_failed");
      window.location.href = `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/mercado-livre/connect`;
    } catch {
      setError(true);
      setSavingCredentials(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!workspaceId || !connection) return;
    if (
      !window.confirm(
        "Desconectar o Mercado Livre? A busca de produtos e a importação de ofertas serão interrompidas.",
      )
    )
      return;
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

  const testConnection = async (): Promise<void> => {
    if (!workspaceId || !connection || testing) return;
    setTesting(true);
    try {
      const response = await request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/${encodeURIComponent(connection.id)}/test`,
        { method: "POST", credentials: "include" },
      );
      setTestResult((await response.json()) as TestOutcome);
    } catch {
      setTestResult({
        ok: false,
        reason: "provider_unavailable",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  };

  const copyRedirectUri = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(REDIRECT_URI);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ponytail: clipboard permission can be denied silently; the URI is still selectable text.
    }
  };

  if (!workspaceId) return null;

  return (
    <section className="slip" aria-labelledby="mercado-livre-title">
      <h2 id="mercado-livre-title">Mercado Livre</h2>
      <p className="hint">
        Conecte sua conta do Mercado Livre para buscar produtos e importar ofertas.
      </p>
      {justConnected ? (
        <p className="alert-line" data-tone="ok" role="status">
          Conta do Mercado Livre conectada com sucesso!
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
            <dt>Conta do Mercado Livre: {connection.displayName ?? connection.accountId}</dt>
            <dd>
              <Chip tone="ok">Conectada</Chip>
            </dd>
            {testResult ? (
              <>
                <dt>Teste</dt>
                <dd>
                  <Chip tone={testResult.ok ? "ok" : "bad"}>
                    {testResult.ok ? "Funcionando" : testReasonLabel(testResult.reason)}
                  </Chip>{" "}
                  Verificado às {formatCheckedAt(testResult.checkedAt)}
                </dd>
              </>
            ) : null}
          </dl>
          <div className="actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              data-action="test-mercado-livre"
              disabled={testing}
              onClick={() => void testConnection()}
            >
              {testing ? "Testando" : "Testar conexão"}
            </button>
            {canManage ? (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                data-action="disconnect-mercado-livre"
                disabled={disconnecting}
                onClick={() => void disconnect()}
              >
                {disconnecting ? "Desconectando" : "Desconectar"}
              </button>
            ) : null}
          </div>
        </>
      ) : null}
      {loaded && !connection && canManage ? (
        <>
          <p className="hint">Cadastre esta Redirect URI no app do Mercado Livre.</p>
          <div className="copy-line">
            <code id="ml-redirect-uri">{REDIRECT_URI}</code>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void copyRedirectUri()}
            >
              {copied ? "Copiado" : "Copiar"}
            </button>
          </div>
          <form
            className="desk-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveCredentialsAndConnect();
            }}
          >
            <label htmlFor="ml-app-id">
              APP ID do Mercado Livre
              <input
                id="ml-app-id"
                aria-label="Mercado Livre App ID"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                required
              />
            </label>
            <label htmlFor="ml-app-secret">
              Secret do Mercado Livre
              <input
                id="ml-app-secret"
                aria-label="Mercado Livre App Secret"
                type="password"
                autoComplete="off"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                required
              />
            </label>
            <div className="actions">
              <button type="submit" className="btn btn-primary" disabled={savingCredentials}>
                {savingCredentials ? "Conectando" : "Conectar Mercado Livre"}
              </button>
            </div>
          </form>
        </>
      ) : null}
      {loaded && !connection && !canManage ? (
        <p className="hint">Somente proprietários e operadores podem conectar o Mercado Livre.</p>
      ) : null}
      {error ? (
        <p className="alert-line" data-tone="bad" role="alert">
          Não foi possível atualizar esta conexão. Tente novamente.
        </p>
      ) : null}
    </section>
  );
};
