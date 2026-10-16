import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { type WorkspaceOption, WorkspaceSwitcher } from "../workspaces/workspace-switcher.js";

type SessionUser = Readonly<{ id: string; email: string }>;
type SessionResponse =
  | Readonly<{ authenticated: false }>
  | Readonly<{ authenticated: true; user: SessionUser }>;

type WorkspaceResponse = Readonly<{ workspaces: readonly WorkspaceOption[] }>;

type AuthenticatedShellProps = Readonly<{
  children: ReactNode;
  request?: typeof fetch;
}>;

type ShellState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "unauthenticated" }>
  | Readonly<{
      status: "authenticated";
      user: SessionUser;
      workspaces: readonly WorkspaceOption[];
      selectedWorkspaceId: string | undefined;
      selectedWorkspaceRole: WorkspaceOption["role"] | undefined;
    }>
  | Readonly<{ status: "error" }>;

const readSession = (payload: unknown): SessionResponse | null => {
  if (typeof payload !== "object" || payload === null || !("authenticated" in payload)) {
    return null;
  }
  if (payload.authenticated === false) return { authenticated: false };
  if (
    payload.authenticated === true &&
    "user" in payload &&
    typeof payload.user === "object" &&
    payload.user !== null &&
    "id" in payload.user &&
    typeof payload.user.id === "string" &&
    "email" in payload.user &&
    typeof payload.user.email === "string"
  ) {
    return {
      authenticated: true,
      user: { id: payload.user.id, email: payload.user.email },
    };
  }
  return null;
};

const readWorkspaces = (payload: unknown): WorkspaceResponse | null => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("workspaces" in payload) ||
    !Array.isArray(payload.workspaces)
  )
    return null;
  const workspaces = payload.workspaces.filter((workspace): workspace is WorkspaceOption => {
    if (typeof workspace !== "object" || workspace === null) return false;
    return (
      "id" in workspace &&
      typeof workspace.id === "string" &&
      "name" in workspace &&
      typeof workspace.name === "string" &&
      "role" in workspace &&
      (workspace.role === "owner" || workspace.role === "operator" || workspace.role === "reviewer")
    );
  });
  return workspaces.length === payload.workspaces.length ? { workspaces } : null;
};

export const SelectedWorkspaceContext = createContext<string | undefined>(undefined);
export const useSelectedWorkspaceId = (): string | undefined =>
  useContext(SelectedWorkspaceContext);
export const SelectedWorkspaceRoleContext = createContext<WorkspaceOption["role"] | undefined>(
  undefined,
);
export const useSelectedWorkspaceRole = (): WorkspaceOption["role"] | undefined =>
  useContext(SelectedWorkspaceRoleContext);

export const AuthenticatedShell = ({ children, request = fetch }: AuthenticatedShellProps) => {
  const [state, setState] = useState<ShellState>({ status: "loading" });

  const loadSession = useCallback(async (): Promise<void> => {
    try {
      const response = await request("/v1/auth/session", { credentials: "include" });
      if (!response.ok) throw new Error("session_request_failed");
      const session = readSession(await response.json());
      if (!session) throw new Error("session_response_invalid");
      if (!session.authenticated) {
        setState({ status: "unauthenticated" });
        return;
      }
      const workspacesResponse = await request("/v1/me/workspaces", { credentials: "include" });
      if (!workspacesResponse.ok) throw new Error("workspace_request_failed");
      const workspaceData = readWorkspaces(await workspacesResponse.json());
      if (!workspaceData) throw new Error("workspace_response_invalid");
      const requestedWorkspaceId =
        new URLSearchParams(window.location.search).get("workspaceId") ?? undefined;
      const selectedWorkspaceId = workspaceData.workspaces.some(
        ({ id }) => id === requestedWorkspaceId,
      )
        ? requestedWorkspaceId
        : workspaceData.workspaces[0]?.id;
      const selectedWorkspaceRole = workspaceData.workspaces.find(
        ({ id }) => id === selectedWorkspaceId,
      )?.role;
      setState({
        status: "authenticated",
        user: session.user,
        workspaces: workspaceData.workspaces,
        selectedWorkspaceId,
        selectedWorkspaceRole,
      });
    } catch {
      setState({ status: "error" });
    }
  }, [request]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const logout = async (): Promise<void> => {
    try {
      const response = await request("/v1/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { origin: window.location.origin },
      });
      if (!response.ok) throw new Error("logout_failed");
      setState({ status: "unauthenticated" });
    } catch {
      setState({ status: "error" });
    }
  };

  if (state.status === "loading") {
    return (
      <main className="page-shell" aria-busy="true">
        <p>Verificando sua sessão…</p>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="page-shell" aria-labelledby="auth-error-title">
        <section className="card">
          <p className="wordmark">Content Factory</p>
          <h1 id="auth-error-title">Não foi possível verificar sua sessão</h1>
          <p>O servidor não respondeu. Confira sua conexão e tente de novo.</p>
          <button type="button" onClick={() => void loadSession()}>
            Tentar novamente
          </button>
        </section>
      </main>
    );
  }
  if (state.status === "unauthenticated") {
    return (
      <main className="page-shell" aria-labelledby="sign-in-title">
        <section className="card">
          <p className="wordmark">Content Factory</p>
          <h1 id="sign-in-title">Entrar para continuar</h1>
          <p>
            Os pacotes para revisar, os links, as ofertas e os resultados aparecem depois de entrar.
          </p>
          <a className="button-link" href="/v1/auth/login">
            Entrar
          </a>
          <p className="fine-print">Acesso só com convite</p>
        </section>
      </main>
    );
  }

  const changeWorkspace = (selectedWorkspaceId: string): void => {
    if (!state.workspaces.some(({ id }) => id === selectedWorkspaceId)) return;
    const selectedWorkspaceRole = state.workspaces.find(
      ({ id }) => id === selectedWorkspaceId,
    )?.role;
    const url = new URL(window.location.href);
    url.searchParams.set("workspaceId", selectedWorkspaceId);
    window.history.replaceState({}, "", url);
    setState({ ...state, selectedWorkspaceId, selectedWorkspaceRole });
  };

  return (
    <SelectedWorkspaceContext.Provider value={state.selectedWorkspaceId}>
      <SelectedWorkspaceRoleContext.Provider value={state.selectedWorkspaceRole}>
        <div className="desk">
          <header className="desk-top">
            <a className="desk-wordmark" href="/" aria-label="Content Factory, início">
              <i aria-hidden="true" />
              Content Factory
            </a>
            {state.workspaces.length > 0 ? (
              <WorkspaceSwitcher
                workspaces={state.workspaces}
                selectedWorkspaceId={state.selectedWorkspaceId}
                onChange={changeWorkspace}
              />
            ) : null}
            <span className="desk-user">{state.user.email}</span>
            <button type="button" data-action="logout" onClick={() => void logout()}>
              Sair
            </button>
          </header>
          {children}
        </div>
      </SelectedWorkspaceRoleContext.Provider>
    </SelectedWorkspaceContext.Provider>
  );
};
