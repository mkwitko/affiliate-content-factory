import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chip } from "../panel/desk.js";
import { formatCheckedAt, testReasonLabel } from "./connection-test-reason.js";
import {
  type ProviderConnectionClient,
  ProviderConnectionCreateError,
  ProviderConnectionForm,
} from "./provider-connection-form.js";
import { suggestInstagramHandle } from "./suggest-instagram-handle.js";

export type ProviderConnectionSummary = Readonly<{
  id: string;
  provider: "post_for_me";
  mode: "api_key" | "oauth";
  status: "active" | "revoked" | "unhealthy";
  accountId: string;
  displayName?: string | null;
}>;

type TestOutcome =
  | Readonly<{ ok: true; account: string; checkedAt: string }>
  | Readonly<{ ok: false; reason: string; checkedAt: string }>;

type ProviderConnectionPanelProps = Readonly<{
  workspaceId?: string;
  role: "owner" | "operator" | "reviewer";
  request?: typeof fetch;
}>;

type PanelState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; connections: readonly ProviderConnectionSummary[] }>;

const readConnections = (payload: unknown): readonly ProviderConnectionSummary[] | null => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("connections" in payload) ||
    !Array.isArray(payload.connections)
  )
    return null;
  const connections = payload.connections.filter(
    (connection): connection is ProviderConnectionSummary => {
      if (typeof connection !== "object" || connection === null) return false;
      return (
        "id" in connection &&
        typeof connection.id === "string" &&
        "provider" in connection &&
        connection.provider === "post_for_me" &&
        "mode" in connection &&
        (connection.mode === "api_key" || connection.mode === "oauth") &&
        "status" in connection &&
        (connection.status === "active" ||
          connection.status === "revoked" ||
          connection.status === "unhealthy") &&
        "accountId" in connection &&
        typeof connection.accountId === "string"
      );
    },
  );
  // Other providers (e.g. Mercado Livre) have their own panel; only Post For Me entries must be valid.
  const postForMeCount = payload.connections.filter(
    (connection) =>
      typeof connection === "object" &&
      connection !== null &&
      "provider" in connection &&
      connection.provider === "post_for_me",
  ).length;
  return connections.length === postForMeCount ? connections : null;
};

const responseOrError = async (response: Response): Promise<Response> => {
  if (!response.ok) throw new Error("provider_connection_request_failed");
  return response;
};

export const ProviderConnectionPanel = ({
  workspaceId,
  role,
  request = fetch,
}: ProviderConnectionPanelProps) => {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState(false);
  const pendingActionRef = useRef<string | null>(null);
  const canManage = role === "owner" || role === "operator";
  const [nicheNames, setNicheNames] = useState<readonly string[]>([]);

  // Niches are optional context for pre-filling handles; a failure just shows the generic form.
  useEffect(() => {
    if (!workspaceId) return;
    let current = true;
    void request(`/v1/workspaces/${encodeURIComponent(workspaceId)}/operator-context`, {
      credentials: "include",
    })
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        const niches = (payload as { niches?: unknown } | null)?.niches;
        if (!current || !Array.isArray(niches)) return;
        setNicheNames(
          niches
            .map((niche) => (niche as { name?: unknown }).name)
            .filter((name): name is string => typeof name === "string"),
        );
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [request, workspaceId]);

  const load = useCallback(async (): Promise<readonly ProviderConnectionSummary[]> => {
    if (!workspaceId) return [];
    const response = await request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections`,
      { credentials: "include" },
    );
    await responseOrError(response);
    const parsed = readConnections(await response.json());
    if (!parsed) throw new Error("provider_connection_response_invalid");
    return parsed;
  }, [request, workspaceId]);

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    setMutationError(false);
    void load()
      .then((connections) => {
        if (current) setState({ status: "ready", connections });
      })
      .catch(() => {
        if (current) setState({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [load]);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setState({ status: "loading" });
      setMutationError(false);
      setState({ status: "ready", connections: await load() });
    } catch {
      setMutationError(true);
      setState({ status: "error" });
    }
  }, [load]);

  const client = useMemo<ProviderConnectionClient>(
    () => ({
      create: async (apiKey, accountId) => {
        if (!workspaceId) throw new Error("workspace_required");
        const response = await request(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/post-for-me`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ apiKey, accountId }),
          },
        );
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: string; availableAccounts?: unknown };
          } | null;
          const code = body?.error?.code;
          if (code === "INVALID_API_KEY")
            throw new ProviderConnectionCreateError("invalid_api_key");
          if (code === "ACCOUNT_NOT_FOUND") {
            const availableAccounts = Array.isArray(body?.error?.availableAccounts)
              ? body.error.availableAccounts.filter(
                  (value): value is string => typeof value === "string",
                )
              : [];
            throw new ProviderConnectionCreateError("account_not_found", availableAccounts);
          }
          throw new Error("provider_connection_request_failed");
        }
        await refresh();
      },
    }),
    [refresh, request, workspaceId],
  );

  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  const testConnection = async (connectionId: string): Promise<void> => {
    if (!workspaceId || testingId) return;
    setTestingId(connectionId);
    try {
      const response = await request(
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/${encodeURIComponent(connectionId)}/test`,
        { method: "POST", credentials: "include" },
      );
      const body = (await response.json()) as TestOutcome;
      setTestResults((previous) => ({ ...previous, [connectionId]: body }));
    } catch {
      setTestResults((previous) => ({
        ...previous,
        [connectionId]: {
          ok: false,
          reason: "provider_unavailable",
          checkedAt: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const revoke = async (connectionId: string): Promise<void> => {
    if (!workspaceId || pendingActionRef.current) return;
    if (!window.confirm("Revogar esta conexão do Post For Me? A publicação será interrompida."))
      return;
    pendingActionRef.current = connectionId;
    setPendingAction(connectionId);
    setMutationError(false);
    try {
      await responseOrError(
        await request(
          `/v1/workspaces/${encodeURIComponent(workspaceId)}/provider-connections/${encodeURIComponent(connectionId)}`,
          { method: "DELETE", credentials: "include" },
        ),
      );
      await refresh();
    } catch {
      setMutationError(true);
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  };

  if (!workspaceId) return null;

  return (
    <>
      <section className="slip" aria-labelledby="provider-connection-title">
        <h2 id="provider-connection-title">Contas do Post For Me</h2>
        <p className="hint">
          Cada conta do Instagram publica com sua própria chave de API do Post For Me.
        </p>
        {state.status === "loading" ? (
          <p className="alert-line" data-tone="quiet">
            Carregando status da conexão…
          </p>
        ) : null}
        {state.status === "error" ? (
          <p className="alert-line" data-tone="bad" role="alert">
            Não foi possível carregar esta conexão de workspace.
          </p>
        ) : null}
        {state.status === "ready" && state.connections.length === 0 ? (
          <p className="alert-line" data-tone="quiet">
            Nenhuma conta do Instagram conectada ainda.
          </p>
        ) : null}
        {state.status === "ready" && state.connections.length > 0
          ? state.connections.map((connection) => (
              <details key={connection.id}>
                <summary>
                  <span>@{connection.displayName ?? connection.accountId}</span>
                  <Chip tone={connection.status === "active" ? "ok" : "quiet"}>
                    {connection.status === "active" ? "Conectada" : "Inativa"}
                  </Chip>
                </summary>
                <dl className="facts">
                  <dt>Modo</dt>
                  <dd>{connection.mode === "api_key" ? "Chave de API" : "OAuth"}</dd>
                  {(() => {
                    const result = testResults[connection.id];
                    if (!result) return null;
                    return (
                      <>
                        <dt>Teste</dt>
                        <dd>
                          <Chip tone={result.ok ? "ok" : "bad"}>
                            {result.ok ? "Funcionando" : testReasonLabel(result.reason)}
                          </Chip>{" "}
                          Verificado às {formatCheckedAt(result.checkedAt)}
                        </dd>
                      </>
                    );
                  })()}
                </dl>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    data-action="test-connection"
                    disabled={testingId !== null}
                    onClick={() => void testConnection(connection.id)}
                  >
                    {testingId === connection.id ? "Testando" : "Testar conexão"}
                  </button>
                  {canManage && connection.status === "active" ? (
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      data-action="revoke"
                      disabled={pendingAction !== null}
                      onClick={() => void revoke(connection.id)}
                    >
                      {pendingAction === connection.id ? "Revogando" : "Revogar"}
                    </button>
                  ) : null}
                </div>
              </details>
            ))
          : null}
        {mutationError ? (
          <p className="alert-line" data-tone="bad" role="alert">
            Não foi possível atualizar esta conexão. Tente novamente.
          </p>
        ) : null}
      </section>
      {canManage && state.status === "ready"
        ? nicheNames
            .map((name) => ({ name, handle: suggestInstagramHandle(name) }))
            .filter(
              ({ handle }) =>
                handle &&
                !state.connections.some(
                  (connection) =>
                    (connection.displayName ?? connection.accountId)
                      .replace(/^@/, "")
                      .toLowerCase() === handle,
                ),
            )
            .map(({ name, handle }) => (
              <section className="slip" key={handle}>
                <h2>{name}</h2>
                <p className="hint">
                  Conta sugerida a partir do nicho. Confira o @ e cole a API key do Post For Me.
                </p>
                <ProviderConnectionForm
                  client={client}
                  canManage={canManage}
                  initialAccountId={handle}
                />
              </section>
            ))
        : null}
      {canManage ? (
        <section className="slip" aria-labelledby="provider-connection-add-title">
          <h2 id="provider-connection-add-title">
            {nicheNames.length > 0 ? "Outra conta do Instagram" : "Adicionar conta do Instagram"}
          </h2>
          <ProviderConnectionForm client={client} canManage={canManage} />
        </section>
      ) : null}
    </>
  );
};
