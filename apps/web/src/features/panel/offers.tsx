import { Check, ExternalLink, ImageOff, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { AlertLine, Chip, DeskTitle, Empty } from "./desk.js";
import {
  formatMoney,
  formatWhen,
  isFresh,
  type PanelClient,
  type PanelData,
  type PanelOffer,
  stateLabel,
  stateTone,
} from "./panel-data.js";

type Role = "owner" | "operator" | "reviewer";

type OffersDeskProps = Readonly<{
  data: PanelData;
  workspaceId: string;
  role: Role;
  client: PanelClient;
  onChanged: () => Promise<void>;
}>;

const order: Record<string, number> = { draft: 0, active: 1, rejected: 2, archived: 3 };

const parseMoney = (value: string): Readonly<{ amountMinor: number; currency: string }> | null => {
  const digits = value
    .replace(/[^\d,.]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  if (!digits) return null;
  const amount = Number.parseFloat(digits);
  return Number.isFinite(amount) && amount >= 0
    ? { amountMinor: Math.round(amount * 100), currency: "BRL" }
    : null;
};

const OfferForm = ({
  workspaceId,
  client,
  onDone,
}: Readonly<{ workspaceId: string; client: PanelClient; onDone: () => Promise<void> }>) => {
  const [title, setTitle] = useState("");
  const [listingUrl, setListingUrl] = useState("");
  const [affiliateUrl, setAffiliateUrl] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const currentPrice = parseMoney(price);
    const result = await client.createOffer(workspaceId, {
      title: title.trim(),
      listingUrl: listingUrl.trim(),
      ...(affiliateUrl.trim() ? { affiliateUrl: affiliateUrl.trim() } : {}),
      ...(currentPrice ? { currentPrice } : {}),
    });
    setBusy(false);
    if (!result.ok) return setError(result.message);
    setTitle("");
    setListingUrl("");
    setAffiliateUrl("");
    setPrice("");
    await onDone();
  };

  return (
    <form className="desk-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <h2>Nova oferta</h2>
      <p className="hint">
        O preço vira evidência só depois de conferido no Mercado Livre pelo ChatGPT. Aqui você
        registra o produto.
      </p>
      <label>
        Título do produto
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={500}
        />
      </label>
      <label>
        Link do anúncio
        <input
          type="url"
          value={listingUrl}
          onChange={(event) => setListingUrl(event.target.value)}
          required
          placeholder="https://produto.mercadolivre.com.br/…"
        />
      </label>
      <label>
        Link de afiliado (opcional)
        <input
          type="url"
          value={affiliateUrl}
          onChange={(event) => setAffiliateUrl(event.target.value)}
          placeholder="https://mercadolivre.com/sec/…"
        />
      </label>
      <label>
        Preço visto agora (opcional)
        <input
          inputMode="decimal"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          placeholder="R$ 129,90"
        />
      </label>
      {error ? <AlertLine tone="bad">{error}</AlertLine> : null}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          <Plus aria-hidden="true" />
          {busy ? "Salvando…" : "Registrar oferta"}
        </button>
      </div>
    </form>
  );
};

const OfferRow = ({
  offer,
  data,
  role,
  busy,
  onActivate,
  onReject,
}: Readonly<{
  offer: PanelOffer;
  data: PanelData;
  role: Role;
  busy: boolean;
  onActivate: () => void;
  onReject: () => void;
}>) => {
  const niche = data.niches.find(({ id }) => id === offer.nicheId)?.name ?? null;
  const fresh = isFresh(offer.verifiedAt);
  return (
    <li>
      <div
        className="row"
        style={{ cursor: "default" }}
        data-actions={offer.state === "draft" && role !== "reviewer" ? "true" : undefined}
      >
        {offer.imageUrl ? (
          <img className="row-thumb" src={offer.imageUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="row-thumb" aria-hidden="true">
            <ImageOff size={18} />
          </span>
        )}
        <span className="row-body">
          <span className="row-title">{offer.title}</span>
          <span className="row-meta">
            {offer.price ? (
              <strong>{formatMoney(offer.price)}</strong>
            ) : (
              <span>sem preço conferido</span>
            )}
            {offer.listPrice ? <s>{formatMoney(offer.listPrice)}</s> : null}
            {offer.verifiedAt ? (
              <span>
                conferido {formatWhen(offer.verifiedAt)}
                {fresh ? "" : ", vencido"}
              </span>
            ) : null}
            {niche ? <span>{niche}</span> : null}
            {offer.affiliateUrl ? (
              <a
                href={offer.affiliateUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--color-primary)", display: "inline-flex", gap: 4 }}
              >
                anúncio <ExternalLink size={12} aria-hidden="true" />
              </a>
            ) : null}
          </span>
        </span>
        <span className="row-end">
          <Chip tone={stateTone(offer.state)}>{stateLabel(offer.state)}</Chip>
          {offer.state === "draft" && role !== "reviewer" ? (
            <span className="row-actions">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={onReject}
                disabled={busy}
              >
                <X aria-hidden="true" />
                Recusar
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={onActivate}
                disabled={busy}
              >
                <Check aria-hidden="true" />
                Ativar
              </button>
            </span>
          ) : null}
        </span>
      </div>
    </li>
  );
};

export const OffersDesk = ({ data, workspaceId, role, client, onChanged }: OffersDeskProps) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(data.offers.length === 0);
  const offers = [...data.offers].sort(
    (a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.title.localeCompare(b.title),
  );

  const act = async (offerId: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusyId(offerId);
    setError(null);
    const result = await action();
    if (!result.ok) setError(result.message ?? "Algo deu errado.");
    else await onChanged();
    setBusyId(null);
  };

  return (
    <>
      <DeskTitle
        title="Ofertas"
        hint={`${data.offers.filter(({ state }) => state === "active").length} ativas de ${data.offers.length}`}
      />
      {error ? <AlertLine tone="bad">{error}</AlertLine> : null}
      <div className="two-col">
        <div>
          {offers.length === 0 ? (
            <Empty title="Nenhuma oferta ainda">
              <p>
                Registre o primeiro produto ao lado, ou peça ao ChatGPT para importar do Mercado
                Livre com o preço conferido.
              </p>
            </Empty>
          ) : (
            <ul className="rows" aria-label="Ofertas">
              {offers.map((offer) => (
                <OfferRow
                  key={offer.id}
                  offer={offer}
                  data={data}
                  role={role}
                  busy={busyId === offer.id}
                  onActivate={() =>
                    void act(offer.id, () => client.activateOffer(workspaceId, offer.id))
                  }
                  onReject={() => {
                    const reason = window.prompt("Por que recusar esta oferta?");
                    if (reason?.trim())
                      void act(offer.id, () =>
                        client.rejectOffer(workspaceId, offer.id, reason.trim()),
                      );
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        {role !== "reviewer" ? (
          showForm ? (
            <OfferForm
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
              Nova oferta
            </button>
          )
        ) : null}
      </div>
    </>
  );
};
