import { type FormEvent, useId, useRef, useState } from "react";

export type ProviderConnectionClient = Readonly<{
  create: (apiKey: string, accountId: string) => Promise<void>;
}>;

export class ProviderConnectionCreateError extends Error {
  public readonly availableAccounts: readonly string[];

  public constructor(
    public readonly code: "invalid_api_key" | "account_not_found",
    availableAccounts: readonly string[] = [],
  ) {
    super(code);
    this.availableAccounts = availableAccounts;
  }
}

type FormError =
  | Readonly<{ kind: "invalid_api_key" }>
  | Readonly<{ kind: "account_not_found"; availableAccounts: readonly string[] }>
  | Readonly<{ kind: "generic" }>;

const classifyError = (error: unknown): FormError => {
  if (error instanceof ProviderConnectionCreateError) {
    if (error.code === "invalid_api_key") return { kind: "invalid_api_key" };
    return { kind: "account_not_found", availableAccounts: error.availableAccounts };
  }
  return { kind: "generic" };
};

type ProviderConnectionFormProps = Readonly<{
  client: ProviderConnectionClient;
  canManage: boolean;
  onConnected?: () => void;
  /** Pre-fills the Instagram handle (e.g. suggested from a niche); still editable. */
  initialAccountId?: string;
}>;

export const ProviderConnectionForm = ({
  client,
  canManage,
  onConnected,
  initialAccountId = "",
}: ProviderConnectionFormProps) => {
  const fieldId = useId();
  const [apiKey, setApiKey] = useState("");
  const [accountId, setAccountId] = useState(initialAccountId);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<FormError | null>(null);
  const submittingRef = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const key = apiKey.trim();
    const account = accountId.trim();
    if (!canManage || key.length === 0 || account.length === 0 || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitted(false);
    setError(null);
    try {
      await client.create(key, account);
      setSubmitted(true);
      onConnected?.();
    } catch (caught) {
      setError(classifyError(caught));
    } finally {
      setApiKey("");
      setAccountId(initialAccountId);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!canManage) {
    return <p className="hint">Somente proprietários e operadores podem alterar esta conexão.</p>;
  }

  return (
    <form onSubmit={submit} aria-busy={submitting} className="desk-form">
      <label htmlFor={`${fieldId}-account`}>
        Conta do Instagram
        <input
          id={`${fieldId}-account`}
          aria-label="Instagram account label"
          type="text"
          placeholder="exampleshop.home"
          autoComplete="off"
          value={accountId}
          onChange={(event) => setAccountId(event.target.value)}
          required
        />
      </label>
      <label htmlFor={`${fieldId}-key`}>
        API key do Post For Me
        <input
          id={`${fieldId}-key`}
          aria-label="Post For Me API key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
        />
      </label>
      {submitted ? (
        <p className="alert-line" data-tone="ok" role="status">
          Conexão salva. A chave de API não é exibida novamente.
        </p>
      ) : null}
      {error?.kind === "invalid_api_key" ? (
        <p className="alert-line" data-tone="bad" role="alert">
          Chave de API inválida. Verifique a chave do Post For Me e tente novamente.
        </p>
      ) : null}
      {error?.kind === "account_not_found" ? (
        <p className="alert-line" data-tone="bad" role="alert">
          Conta do Instagram não encontrada para esta chave.
          {error.availableAccounts.length > 0
            ? ` Contas disponíveis nesta chave: ${error.availableAccounts.map((account) => `@${account}`).join(", ")}.`
            : ""}
        </p>
      ) : null}
      {error?.kind === "generic" ? (
        <p className="alert-line" data-tone="bad" role="alert">
          Não foi possível salvar esta conexão. A chave de API foi apagada; tente novamente se
          necessário.
        </p>
      ) : null}
      <div className="actions">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={apiKey.trim().length === 0 || accountId.trim().length === 0 || submitting}
        >
          {submitting ? "Conectando" : "Conectar conta"}
        </button>
      </div>
    </form>
  );
};
