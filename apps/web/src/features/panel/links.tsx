import { ExternalLink, Link2, Save } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AlertLine, DeskTitle, Empty } from "./desk.js";
import { formatMoney, type LinkCandidate, type LinkQueue, type PanelClient } from "./panel-data.js";

type LinksDeskProps = Readonly<{
  queue: LinkQueue | null;
  workspaceId: string;
  role: "owner" | "operator" | "reviewer";
  client: PanelClient;
  onChanged: () => Promise<void>;
}>;

/** One product, one pasted link, one save: the only typing the owner does. */
const LinkRow = ({
  item,
  workspaceId,
  canSubmit,
  client,
  onSaved,
}: Readonly<{
  item: LinkCandidate;
  workspaceId: string;
  canSubmit: boolean;
  client: PanelClient;
  onSaved: () => Promise<void>;
}>) => {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Readonly<{ ok: boolean; message: string }> | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    const result = await client.submitLink(workspaceId, item.candidateId, url.trim());
    setBusy(false);
    setOutcome({ ok: result.ok, message: result.message ?? "Link salvo." });
    if (result.ok) await onSaved();
  };

  return (
    <li>
      <div className="row" style={{ cursor: "default", flexWrap: "wrap" }}>
        <span className="row-body">
          <span className="row-title">{item.title}</span>
          <span className="row-meta">
            <strong>{formatMoney(item.price)}</strong>
          </span>
        </span>
        <span className="row-actions">
          <a
            className="btn btn-outline btn-sm"
            href={item.listingUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink aria-hidden="true" />
            Anúncio
          </a>
          <a
            className="btn btn-outline btn-sm"
            href={item.affiliateLinkBuilderUrl}
            target="_blank"
            rel="noreferrer"
          >
            <Link2 aria-hidden="true" />
            Gerar link
          </a>
        </span>
        {canSubmit ? (
          <form
            onSubmit={(event) => void submit(event)}
            aria-busy={busy}
            style={{ display: "flex", gap: 8, flexBasis: "100%" }}
          >
            <input
              type="url"
              aria-label={`Link de afiliado de ${item.title}`}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              placeholder="Cole o link aqui"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !url.trim()}>
              <Save aria-hidden="true" />
              {busy ? "Salvando…" : "Salvar"}
            </button>
          </form>
        ) : null}
      </div>
      {outcome ? <AlertLine tone={outcome.ok ? "ok" : "bad"}>{outcome.message}</AlertLine> : null}
    </li>
  );
};

export const LinksDesk = ({ queue, workspaceId, role, client, onChanged }: LinksDeskProps) => {
  const groups = new Map<string, LinkCandidate[]>();
  for (const item of queue?.items ?? []) {
    const name = item.nicheName ?? "Sem nicho";
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return (
    <>
      <DeskTitle
        title="Links"
        hint={
          queue && queue.items.length > 0
            ? `${queue.items.length} ${queue.items.length === 1 ? "produto espera" : "produtos esperam"} seu link`
            : "Nada esperando por você."
        }
      />
      {!queue ? (
        <AlertLine tone="bad">Não deu para carregar a fila de links.</AlertLine>
      ) : queue.items.length === 0 ? (
        <Empty title="Nenhum produto esperando link">
          <p>A fábrica escolhe os produtos. Quando precisar de um link, ele aparece aqui.</p>
        </Empty>
      ) : (
        [...groups].map(([name, items]) => (
          <section key={name}>
            <h2>{name}</h2>
            <ul className="rows" aria-label={name}>
              {items.map((item) => (
                <LinkRow
                  key={item.candidateId}
                  item={item}
                  workspaceId={workspaceId}
                  canSubmit={role !== "reviewer"}
                  client={client}
                  onSaved={onChanged}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
};
