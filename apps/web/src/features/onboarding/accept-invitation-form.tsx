import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";

export type InvitationAcceptanceResult = Readonly<{
  status: "accepted" | "already_accepted";
  invitationId: string;
}>;

export type InvitationApiError = Readonly<{
  code: string;
  message?: string;
}>;

export type InvitationAcceptanceClient = Readonly<{
  accept: (token: string, email: string) => Promise<InvitationAcceptanceResult>;
}>;

type AcceptInvitationFormProps = Readonly<{
  token: string;
  client: InvitationAcceptanceClient;
}>;

type FormState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "accepting" }>
  | Readonly<{ status: "accepted"; invitationId: string }>
  | Readonly<{ status: "error"; code: string }>;

const errorMessage = (code: string): string => {
  switch (code) {
    case "INVITATION_NOT_FOUND":
      return "Este convite é inválido ou não está mais disponível.";
    case "INVITATION_EXPIRED":
      return "Este convite expirou. Peça um novo a quem administra o espaço.";
    case "INVITATION_REVOKED":
      return "Este convite foi cancelado. Peça um novo a quem administra o espaço.";
    case "INVITATION_EMAIL_MISMATCH":
      return "Use o e-mail que recebeu este convite.";
    default:
      return "Não deu para aceitar o convite.";
  }
};

const canRetry = (code: string): boolean =>
  code === "UNKNOWN" || code === "INTERNAL_ERROR" || code === "SERVICE_UNAVAILABLE";

const readErrorCode = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return "UNKNOWN";
};

export const AcceptInvitationForm = ({ token, client }: AcceptInvitationFormProps) => {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>({ status: "idle" });
  const submissionInFlight = useRef(false);

  const submit = async (submittedEmail = email): Promise<void> => {
    if (submissionInFlight.current || state.status === "accepted") return;
    submissionInFlight.current = true;
    setState({ status: "accepting" });

    try {
      const result = await client.accept(token, submittedEmail.trim());
      setState({ status: "accepted", invitationId: result.invitationId });
    } catch (error) {
      setState({ status: "error", code: readErrorCode(error) });
    } finally {
      submissionInFlight.current = false;
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!event.currentTarget.checkValidity()) return;
    await submit();
  };

  const handleEmailKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (
      event.key !== "Enter" ||
      submissionInFlight.current ||
      !event.currentTarget.checkValidity()
    ) {
      return;
    }
    event.preventDefault();
    void submit(event.currentTarget.value);
  };

  if (state.status === "accepted") {
    return (
      <main className="page-shell" aria-labelledby="workspace-ready-title">
        <section className="card" aria-live="polite">
          <p className="wordmark">Content Factory</p>
          <h1 id="workspace-ready-title">Seu espaço está pronto</h1>
          <p>Convite aceito. Os pacotes para revisar, os links e os resultados ficam no painel.</p>
          <a className="button-link" href="/">
            Abrir o painel
          </a>
        </section>
      </main>
    );
  }

  const isAccepting = state.status === "accepting";
  const errorCode = state.status === "error" ? state.code : null;
  const error = errorCode ? errorMessage(errorCode) : null;

  return (
    <main className="page-shell" aria-labelledby="invitation-title">
      <section className="card">
        <p className="wordmark">Content Factory</p>
        <h1 id="invitation-title">Aceitar convite</h1>
        <p>Digite o e-mail que recebeu este convite para entrar no espaço de trabalho.</p>

        <form onSubmit={handleSubmit} aria-busy={isAccepting}>
          <p className="status-message" aria-live="polite" aria-atomic="true">
            {isAccepting ? "Aceitando o convite…" : ""}
          </p>
          <div className="field">
            <label htmlFor="invitation-email">E-mail</label>
            <input
              id="invitation-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={handleEmailKeyDown}
              disabled={isAccepting}
            />
          </div>

          {error ? (
            <div className="message error" role="alert">
              <p>{error}</p>
              {errorCode && canRetry(errorCode) ? (
                <button type="button" className="secondary-button" onClick={() => void submit()}>
                  Tentar de novo
                </button>
              ) : null}
            </div>
          ) : null}

          <button type="submit" disabled={isAccepting || email.trim().length === 0}>
            {isAccepting ? "Aceitando…" : "Entrar no espaço"}
          </button>
        </form>
        <p className="fine-print">Acesso só com convite</p>
      </section>
    </main>
  );
};

type ApiErrorPayload = Readonly<{
  error?: Readonly<{ code?: unknown }>;
}>;

const parseErrorPayload = (payload: unknown): InvitationApiError => {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const error = (payload as ApiErrorPayload).error;
    if (error && typeof error.code === "string") return { code: error.code };
  }
  return { code: "UNKNOWN" };
};

export const createInvitationAcceptanceClient = (
  request: typeof fetch = fetch,
): InvitationAcceptanceClient => ({
  accept: async (token, email) => {
    const response = await request(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw parseErrorPayload(payload);

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("invitationId" in payload) ||
      typeof payload.invitationId !== "string"
    ) {
      throw { code: "UNKNOWN" } satisfies InvitationApiError;
    }

    if (
      !("status" in payload) ||
      (payload.status !== "accepted" && payload.status !== "already_accepted")
    ) {
      throw { code: "UNKNOWN" } satisfies InvitationApiError;
    }

    const status = payload.status;
    return { invitationId: payload.invitationId, status };
  },
});
