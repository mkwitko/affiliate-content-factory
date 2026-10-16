import { ExternalLink, Plus, UserPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AlertLine, Chip, DeskTitle, Empty } from "./desk.js";
import {
  channelLabel,
  type PanelClient,
  type PanelData,
  stateLabel,
  stateTone,
} from "./panel-data.js";

type Role = "owner" | "operator" | "reviewer";

type NichesDeskProps = Readonly<{
  data: PanelData;
  workspaceId: string;
  role: Role;
  client: PanelClient;
  onChanged: () => Promise<void>;
}>;

const NicheForm = ({
  workspaceId,
  client,
  onDone,
}: Readonly<{ workspaceId: string; client: PanelClient; onDone: () => Promise<void> }>) => {
  const [form, setForm] = useState({
    name: "",
    audience: "",
    problem: "",
    editorialVoice: "",
    monetizationHypothesis: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await client.createNiche(workspaceId, {
      name: form.name.trim(),
      audience: form.audience.trim(),
      problem: form.problem.trim(),
      editorialVoice: form.editorialVoice.trim(),
      monetizationHypothesis: form.monetizationHypothesis.trim(),
      languages: ["pt-BR"],
    });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setForm({
      name: "",
      audience: "",
      problem: "",
      editorialVoice: "",
      monetizationHypothesis: "",
    });
    await onDone();
  };

  return (
    <form className="desk-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>Novo nicho</h2>
      <label>
        Nome
        <input
          value={form.name}
          onChange={set("name")}
          required
          maxLength={200}
          placeholder="Example Shop Home"
        />
      </label>
      <label>
        Para quem
        <input
          value={form.audience}
          onChange={set("audience")}
          required
          maxLength={500}
          placeholder="Quem mora em apartamento pequeno e quer organizar"
        />
      </label>
      <label>
        Que problema resolve
        <textarea value={form.problem} onChange={set("problem")} required maxLength={1000} />
      </label>
      <label>
        Tom de voz
        <input
          value={form.editorialVoice}
          onChange={set("editorialVoice")}
          required
          maxLength={500}
          placeholder="Direto, prático, sem exagero"
        />
      </label>
      <label>
        Como ganha dinheiro
        <textarea
          value={form.monetizationHypothesis}
          onChange={set("monetizationHypothesis")}
          required
          maxLength={1000}
          placeholder="Afiliado Mercado Livre em produtos de organização até R$ 200"
        />
      </label>
      <p className="hint">
        Idioma: português do Brasil. Canais são criados pelo ChatGPT ao conectar as contas.
      </p>
      {error ? <AlertLine tone="bad">{error}</AlertLine> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <Plus aria-hidden="true" />
          {busy ? "Salvando…" : "Criar nicho"}
        </button>
      </div>
    </form>
  );
};

const InviteForm = ({
  workspaceId,
  client,
}: Readonly<{ workspaceId: string; client: PanelClient }>) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"operator" | "reviewer">("reviewer");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setState(null);
    const result = await client.invite(workspaceId, email.trim(), role);
    setBusy(false);
    if (!result.ok) return setState({ tone: "bad", text: result.message });
    setState({ tone: "ok", text: `Convite criado para ${email.trim()}. Vale por 7 dias.` });
    setEmail("");
  };

  return (
    <form className="desk-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>Convidar alguém</h2>
      <label>
        E-mail
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label>
        Papel
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as "operator" | "reviewer")}
        >
          <option value="reviewer">Revisor: só aprova conteúdo</option>
          <option value="operator">Operador: cadastra, aprova e publica</option>
        </select>
      </label>
      {state ? <AlertLine tone={state.tone}>{state.text}</AlertLine> : null}
      <div className="actions">
        <button type="submit" className="btn btn-outline" disabled={busy}>
          <UserPlus aria-hidden="true" />
          {busy ? "Enviando…" : "Criar convite"}
        </button>
      </div>
    </form>
  );
};

export const NichesDesk = ({ data, workspaceId, role, client, onChanged }: NichesDeskProps) => {
  const [showForm, setShowForm] = useState(data.niches.length === 0);
  return (
    <>
      <DeskTitle
        title="Nichos e canais"
        hint={`${data.niches.length} ${data.niches.length === 1 ? "nicho" : "nichos"}, ${data.channels.length} ${data.channels.length === 1 ? "canal" : "canais"}`}
      />
      <div className="two-col">
        <div style={{ display: "grid", gap: 16 }}>
          {data.niches.length === 0 ? (
            <Empty title="Nenhum nicho ainda">
              <p>
                Um nicho é uma audiência, um problema e uma forma de ganhar. Crie o primeiro ao
                lado.
              </p>
            </Empty>
          ) : (
            <ul className="rows" aria-label="Nichos">
              {data.niches.map((niche) => (
                <li key={niche.id}>
                  <div
                    className="row"
                    style={{ cursor: "default", gridTemplateColumns: "1fr auto" }}
                  >
                    <span className="row-body">
                      <span className="row-title">{niche.name}</span>
                      <span className="row-meta">
                        <span>{niche.languages.join(", ") || "pt-BR"}</span>
                        {niche.slug ? (
                          <a
                            href={`/n/${niche.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            style={{
                              color: "var(--color-primary)",
                              display: "inline-flex",
                              gap: 4,
                            }}
                          >
                            vitrine /n/{niche.slug} <ExternalLink size={12} aria-hidden="true" />
                          </a>
                        ) : null}
                      </span>
                    </span>
                    <span className="row-end">
                      <Chip tone={stateTone(niche.state)}>{stateLabel(niche.state)}</Chip>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.channels.length > 0 ? (
            <ul className="rows" aria-label="Canais">
              {data.channels.map((channel) => (
                <li key={channel.id}>
                  <div
                    className="row"
                    style={{ cursor: "default", gridTemplateColumns: "1fr auto" }}
                  >
                    <span className="row-body">
                      <span className="row-title">{channel.label}</span>
                      <span className="row-meta">
                        <strong>{channelLabel(channel.kind)}</strong>
                      </span>
                    </span>
                    <span className="row-end">
                      <Chip tone={stateTone(channel.status)}>{stateLabel(channel.status)}</Chip>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {role !== "reviewer" ? (
          <div style={{ display: "grid", gap: 16 }}>
            {showForm ? (
              <NicheForm
                workspaceId={workspaceId}
                client={client}
                onDone={async () => {
                  await onChanged();
                  setShowForm(false);
                }}
              />
            ) : (
              <button type="button" className="btn btn-outline" onClick={() => setShowForm(true)}>
                <Plus aria-hidden="true" />
                Novo nicho
              </button>
            )}
            <InviteForm workspaceId={workspaceId} client={client} />
          </div>
        ) : null}
      </div>
    </>
  );
};
