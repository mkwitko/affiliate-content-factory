import { Camera, ShoppingBag } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

type Money = Readonly<{ amountMinor: number; currency: string }>;

/** A Mercado Livre price read at `verifiedAt`; the API only sends one read in the last 24h. */
export type StorefrontPrice = Readonly<{ current: Money; list?: Money; verifiedAt: string }>;

export type StorefrontCard = Readonly<{
  offerId: string;
  offerTitle: string;
  imageUrl: string;
  href: string;
  price?: StorefrontPrice;
}>;

export type StorefrontPayload = Readonly<{
  nicheName: string;
  instagramHandle: string | null;
  cards: readonly StorefrontCard[];
}>;

type StorefrontState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "ready"; data: StorefrontPayload }>;

type NicheStorefrontRouteProps = Readonly<{
  slug: string;
  request?: typeof fetch;
}>;

const readMoney = (value: unknown): Money | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { amountMinor, currency } = value as Record<string, unknown>;
  return Number.isInteger(amountMinor) &&
    typeof currency === "string" &&
    /^[A-Z]{3}$/.test(currency)
    ? { amountMinor: amountMinor as number, currency }
    : undefined;
};

/** A malformed price is dropped, never shown; the card itself still renders. */
const readPrice = (record: Record<string, unknown>): StorefrontPrice | undefined => {
  const current = readMoney(record.price);
  const verifiedAt = record.priceVerifiedAt;
  if (!current || typeof verifiedAt !== "string" || Number.isNaN(Date.parse(verifiedAt)))
    return undefined;
  const list = readMoney(record.listPrice);
  return { current, ...(list ? { list } : {}), verifiedAt };
};

const readCard = (value: unknown): StorefrontCard | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.offerTitle !== "string" ||
    typeof record.offerId !== "string" ||
    typeof record.imageUrl !== "string" ||
    typeof record.href !== "string"
  )
    return null;
  const price = readPrice(record);
  return {
    offerId: record.offerId,
    offerTitle: record.offerTitle,
    imageUrl: record.imageUrl,
    href: record.href,
    ...(price ? { price } : {}),
  };
};

const readStorefront = (payload: unknown): StorefrontPayload | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.nicheName !== "string") return null;
  if (record.instagramHandle !== null && typeof record.instagramHandle !== "string") return null;
  if (!Array.isArray(record.cards)) return null;
  const cards = record.cards.map(readCard);
  if (cards.some((card) => card === null)) return null;
  return {
    nicheName: record.nicheName,
    instagramHandle: record.instagramHandle,
    cards: cards as StorefrontCard[],
  };
};

/** "Example Shop Tech" -> ["Example Shop", "Tech"]: the last word names the niche. */
const splitName = (nicheName: string): readonly [string, string] => {
  const words = nicheName.trim().split(/\s+/);
  if (words.length < 2) return ["", nicheName.trim()];
  return [words.slice(0, -1).join(" "), words.at(-1) ?? ""];
};

// ponytail: masthead color picked from the niche name; move it to niche context if niches multiply.
const accents: readonly (readonly [RegExp, string])[] = [
  [/casa/i, "#0f8a4f"],
  [/beleza/i, "#d61c6f"],
];
const accentFor = (nicheName: string): string =>
  accents.find(([pattern]) => pattern.test(nicheName))?.[1] ?? "#1450d6";

const formatMoney = (money: Money): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: money.currency }).format(
    money.amountMinor / 100,
  );

const verifiedFormat = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

const verifiedParts = (verifiedAt: string) =>
  Object.fromEntries(
    verifiedFormat.formatToParts(new Date(verifiedAt)).map((part) => [part.type, part.value]),
  );

/** "no Mercado Livre em 24/09 às 14h", in Brasília time whatever the visitor's clock says. */
export const priceSourceLabel = (verifiedAt: string): string => {
  const parts = verifiedParts(verifiedAt);
  return `no Mercado Livre em ${parts.day}/${parts.month} às ${parts.hour}h`;
};

const instagramUrl = (handle: string): string =>
  `https://www.instagram.com/${encodeURIComponent(handle)}/`;

const recordStorefrontClick = (nicheSlug: string, offerId: string): void => {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;
  navigator.sendBeacon(
    "/v1/public/clicks",
    new Blob([JSON.stringify({ nicheSlug, offerId })], { type: "application/json" }),
  );
};

const FONT_LINK_ID = "storefront-fonts";

/** Loads the flyer faces only for visitors of this public page. */
const useStorefrontFonts = (): void => {
  useEffect(() => {
    if (document.getElementById(FONT_LINK_ID)) return;
    const link = document.createElement("link");
    link.id = FONT_LINK_ID;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Anton&family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap";
    document.head.append(link);
  }, []);
};

/*
 * The weekly deals flyer: white glossy paper, black ink, one niche color for the masthead,
 * encarte yellow starbursts with red numerals, dotted cut lines between the finds.
 */
const CSS = `
.sf {
  --paper: #ffffff; --ink: #111111; --ink-2: #444444; --rule: #111111; --dots: #9a9a9a;
  --yellow: #ffd400; --red: #e3001b; --niche: var(--accent);
  --price: "Anton", "Arial Narrow", Impact, sans-serif;
  --cond: "Barlow Condensed", "Arial Narrow", sans-serif;
  --body: "Barlow", "Helvetica Neue", Arial, sans-serif;
  background: var(--paper); color: var(--ink); min-height: 100vh;
  font: 400 1rem/1.4 var(--body); -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent;
  overflow-x: clip;
}
.sf-hero > * { min-width: 0; }
.sf *, .sf *::before, .sf *::after { box-sizing: border-box; }
.sf a { color: inherit; }
.sf ::selection { background: var(--yellow); color: var(--ink); }
.sf a:focus-visible, .sf button:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
.sf svg { flex: none; }
.sf-wrap { width: 100%; max-width: 1180px; margin: 0 auto; padding: 0 16px; }

/* Masthead: the niche color band. */
.sf-bar { background: var(--niche); color: #fff; }
.sf-bar-in { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; padding-top: 14px; padding-bottom: 12px; }
.sf-brand { margin: 0; display: grid; gap: 0; min-width: 0; line-height: 1; }
.sf-brand-house { font: 700 0.8rem/1 var(--cond); letter-spacing: 0.18em; text-transform: uppercase; opacity: 0.92; }
.sf-brand-niche { font: 400 2.6rem/0.95 var(--price); text-transform: uppercase; letter-spacing: 0.01em; margin-top: 4px; }
.sf-follow-top { display: inline-flex; align-items: center; gap: 6px; height: 40px; padding: 0 12px; flex: none;
  border: 2px solid #fff; color: #fff; font: 700 0.85rem/1 var(--cond); letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; }
.sf-follow-top:hover { background: #fff; color: var(--niche); }
.sf-long { display: none; }
@media (min-width: 420px) { .sf-long { display: inline; } }
.sf-strip { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 2px solid var(--rule);
  font: 700 0.75rem/1 var(--cond); letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); }

/* Cover deal. */
.sf-hero { display: grid; gap: 14px; padding: 16px 0 0; }
.sf-hero-shot { position: relative; display: block; aspect-ratio: 4 / 5; background: #f2f2f2; overflow: hidden; }
.sf-hero-shot img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sf-flag { position: absolute; left: 0; top: 14px; padding: 6px 12px 5px; background: var(--red); color: #fff;
  font: 700 0.8rem/1 var(--cond); letter-spacing: 0.1em; text-transform: uppercase; }
.sf-burst { position: absolute; right: 8px; bottom: 8px; width: 44%; max-width: 280px; aspect-ratio: 1; display: grid; place-items: center;
  text-align: center; color: var(--red); transform-origin: 60% 60%; }
.sf-burst svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.sf-burst-in { position: relative; display: grid; line-height: 0.9; padding: 0 14%; }
.sf-burst-in small { font: 700 0.7rem/1 var(--cond); letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); }
.sf-burst-in b { font: 400 clamp(1.5rem, 9vw, 3.1rem)/0.95 var(--price); letter-spacing: -0.01em; font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) {
  .sf-burst { animation: stamp 260ms cubic-bezier(0.2, 0.9, 0.3, 1) both; animation-delay: 120ms; }
  @keyframes stamp { from { transform: scale(1.14) rotate(-4deg); opacity: 0; } to { transform: none; opacity: 1; } }
}
.sf-hero-title { margin: 0 0 10px; font: 600 1.35rem/1.15 var(--body); letter-spacing: -0.01em;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-wrap: pretty; }
.sf-price { margin: 0 0 14px; display: grid; gap: 6px; }
.sf-price-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.sf-price-was-label { font: 700 0.75rem/1 var(--cond); letter-spacing: 0.1em; text-transform: uppercase; color: var(--ink-2); }
.sf-price-was { font: 600 1.2rem/1 var(--cond); color: var(--ink-2); text-decoration-thickness: 2px; }
.sf-card-none { font: 700 0.75rem/1.25 var(--cond); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
.sf-stamp { justify-self: start; display: inline-block; padding: 5px 8px 4px; border: 2px solid var(--red); color: var(--red);
  font: 700 0.75rem/1 var(--cond); letter-spacing: 0.1em; text-transform: uppercase; transform: rotate(-1.5deg); }
.sf-price-none { margin: 0 0 14px; font: 600 1rem/1.3 var(--cond); text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); }
.sf-cta { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 58px; padding: 0 20px;
  background: var(--red); color: #fff !important; text-decoration: none; text-transform: uppercase;
  font: 700 1.05rem/1 var(--cond); letter-spacing: 0.08em; transition: transform 120ms ease-out, background-color 120ms; }
.sf-cta:hover { background: #c40017; }
.sf-cta:active { transform: scale(0.98); }
.sf-assure { margin: 10px 0 0; font: 500 0.85rem/1.3 var(--body); color: var(--ink-2); }

/* The flyer pages: a grid cut by dotted lines. */
.sf-more { margin-top: 26px; }
.sf-h2 { display: flex; align-items: center; gap: 12px; margin: 0 0 4px; font: 400 1.5rem/1 var(--price); text-transform: uppercase; letter-spacing: 0.02em; }
.sf-h2::after { content: ""; flex: 1; height: 3px; background: var(--ink); }
.sf-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sf-grid li { padding: 14px 10px 16px; border-bottom: 2px dotted var(--dots); border-right: 2px dotted var(--dots); }
.sf-grid li:nth-child(2n) { border-right: 0; }
.sf-card { display: flex; flex-direction: column; height: 100%; text-decoration: none; }
.sf-card-shot { display: block; aspect-ratio: 4 / 5; background: #f2f2f2; overflow: hidden; }
.sf-card-shot img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 160ms ease-out; }
.sf-card:hover .sf-card-shot img { transform: scale(1.03); }
.sf-card-title { margin: 10px 0 6px; font: 500 0.9rem/1.3 var(--body);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sf-card-body { display: flex; flex-direction: column; flex: 1; }
.sf-card-price { margin: 0 0 10px; display: grid; gap: 4px; }
.sf-tag { justify-self: start; display: inline-flex; align-items: baseline; gap: 6px; padding: 3px 8px 2px; background: var(--yellow);
  font: 400 1.25rem/1 var(--price); color: var(--red); font-variant-numeric: tabular-nums; }
.sf-tag s { font: 600 0.75rem/1 var(--cond); color: var(--ink); }
.sf-card-src { font: 600 0.7rem/1.25 var(--cond); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); white-space: pre-line; }
.sf-card-btn { display: flex; align-items: center; justify-content: center; min-height: 40px; margin-top: auto; padding: 0 8px;
  border: 2px solid var(--red); color: var(--red); font: 700 0.8rem/1 var(--cond); letter-spacing: 0.08em; text-transform: uppercase; text-align: center; }
.sf-card:hover .sf-card-btn { background: var(--red); color: #fff; }

/* Follow block and foot. */
.sf-follow { margin: 32px 0 0; padding: 22px 18px; background: var(--niche); color: #fff; }
.sf-follow-title { margin: 0 0 4px; font: 400 1.7rem/1 var(--price); text-transform: uppercase; }
.sf-follow p { margin: 0 0 16px; font: 500 0.95rem/1.3 var(--body); opacity: 0.92; }
.sf-follow-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 0 18px;
  background: #fff; color: var(--niche) !important; font: 700 0.95rem/1 var(--cond); letter-spacing: 0.06em; text-transform: uppercase; text-decoration: none; }
.sf-foot { margin-top: 28px; padding-bottom: 32px; color: var(--ink-2); font: 500 0.8rem/1.4 var(--body); }
.sf-foot > div { padding-top: 12px; border-top: 3px solid var(--ink); }
.sf-foot p { margin: 0 0 4px; max-width: 46rem; }

.sf-state { padding: 40px 0 24px; max-width: 32rem; }
.sf-state-title { margin: 0 0 8px; font: 400 2rem/1 var(--price); text-transform: uppercase; }
.sf-state p { margin: 0 0 18px; color: var(--ink-2); }
.sf-state .sf-cta { width: auto; display: inline-flex; }

.sf-skel { background: #ececec; }
.sf-skel-line { height: 16px; background: #ececec; margin: 0 0 10px; }

@media (min-width: 720px) {
  .sf-brand-niche { font-size: 3.4rem; }
  .sf-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .sf-grid li:nth-child(2n) { border-right: 2px dotted var(--dots); }
  .sf-grid li:nth-child(3n) { border-right: 0; }
  .sf-grid li { padding: 18px 14px 20px; }
}
@media (min-width: 900px) {
  .sf-burst-in b { font-size: 3.1rem; }
  .sf-hero { grid-template-columns: minmax(0, 5fr) minmax(0, 6fr); gap: 40px; align-items: center; padding-top: 24px; }
  .sf-hero-title { font-size: 2rem; margin-bottom: 16px; }
  .sf-cta { width: auto; display: inline-flex; min-width: 340px; }
  .sf-more { margin-top: 40px; }
  .sf-h2 { font-size: 2rem; }
  .sf-follow { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 28px 32px; margin-top: 48px; }
  .sf-follow p { margin: 0; }
}
@media (min-width: 1040px) {
  .sf-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .sf-grid li:nth-child(3n) { border-right: 2px dotted var(--dots); }
  .sf-grid li:nth-child(4n) { border-right: 0; }
}
@media (prefers-reduced-motion: reduce) { .sf-cta, .sf-card-shot img { transition: none; } }
`;

/** A 20-point starburst, drawn once, sized by its box. */
const burstPoints = (): string => {
  const points: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const angle = (Math.PI * index) / 20;
    const radius = index % 2 === 0 ? 50 : 41;
    points.push(
      `${(50 + radius * Math.cos(angle)).toFixed(2)},${(50 + radius * Math.sin(angle)).toFixed(2)}`,
    );
  }
  return points.join(" ");
};
const BURST = burstPoints();

const Burst = ({ price }: { price: StorefrontPrice }) => (
  <span className="sf-burst" aria-hidden="true">
    <svg viewBox="0 0 100 100" role="presentation" focusable="false">
      <polygon points={BURST} fill="#ffd400" />
    </svg>
    <span className="sf-burst-in">
      <small>{price.list ? "só" : "por"}</small>
      <b>{formatMoney(price.current)}</b>
    </span>
  </span>
);

const Stamp = ({ verifiedAt }: { verifiedAt: string }) => (
  <span className="sf-stamp">conferido {priceSourceLabel(verifiedAt)}</span>
);

const Price = ({ price, compact }: { price: StorefrontPrice; compact?: boolean }) =>
  compact ? (
    <span className="sf-card-price">
      <span className="sf-tag">
        {formatMoney(price.current)}
        {price.list ? (
          <s>
            <span className="sr-only">de </span>
            {formatMoney(price.list)}
          </s>
        ) : null}
      </span>
      <span className="sf-card-src">
        {/* Two deliberate lines so a 2-column cell never breaks the label mid-date. */}
        {priceSourceLabel(price.verifiedAt).replace(" em ", "\nem ")}
      </span>
    </span>
  ) : (
    <div className="sf-price">
      {price.list ? (
        <div className="sf-price-row">
          <span className="sf-price-was-label">preço cheio</span>
          <s className="sf-price-was">
            <span className="sr-only">de </span>
            {formatMoney(price.list)}
          </s>
        </div>
      ) : null}
      <Stamp verifiedAt={price.verifiedAt} />
    </div>
  );

const TopBar = ({ nicheName, handle }: { nicheName: string; handle: string | null }) => {
  const [brand, niche] = splitName(nicheName);
  return (
    <header className="sf-bar">
      <div className="sf-wrap sf-bar-in">
        <h1 className="sf-brand">
          {brand ? <span className="sf-brand-house">{brand}</span> : null}
          <span className="sf-brand-niche">{niche}</span>
        </h1>
        {handle ? (
          <a className="sf-follow-top" href={instagramUrl(handle)}>
            <Camera size={16} aria-hidden="true" />
            Seguir<span className="sf-long">&nbsp;no Instagram</span>
          </a>
        ) : null}
      </div>
    </header>
  );
};

const Strip = ({ count }: { count: number }) => (
  <div className="sf-wrap">
    <p className="sf-strip">
      <span>Achados do Mercado Livre</span>
      <span>{count === 1 ? "1 oferta" : `${count} ofertas`}</span>
    </p>
  </div>
);

const Hero = ({ card, nicheSlug }: { card: StorefrontCard; nicheSlug: string }) => (
  <section className="sf-hero" aria-labelledby="sf-hero-title">
    {/* The photo is a second tap target for the same offer; keyboard users get the CTA. */}
    <a
      className="sf-hero-shot"
      href={card.href}
      onClick={() => recordStorefrontClick(nicheSlug, card.offerId)}
      tabIndex={-1}
      aria-label={`${card.offerTitle} no Mercado Livre`}
    >
      <img src={card.imageUrl} alt="" loading="eager" fetchPriority="high" />
      <span className="sf-flag">Achado da semana</span>
      {card.price ? <Burst price={card.price} /> : null}
    </a>
    <div>
      <h2 className="sf-hero-title" id="sf-hero-title">
        {card.offerTitle}
      </h2>
      {card.price ? (
        <Price price={card.price} />
      ) : (
        <p className="sf-price-none">Veja o preço de agora no Mercado Livre.</p>
      )}
      <a
        className="sf-cta"
        href={card.href}
        onClick={() => recordStorefrontClick(nicheSlug, card.offerId)}
      >
        <ShoppingBag size={20} aria-hidden="true" />
        Comprar no Mercado Livre
      </a>
      <p className="sf-assure">
        Pagamento, frete e garantia são do Mercado Livre. Você confere tudo antes de pagar.
      </p>
    </div>
  </section>
);

const Grid = ({ cards, nicheSlug }: { cards: readonly StorefrontCard[]; nicheSlug: string }) => (
  <section className="sf-more" aria-labelledby="sf-more-title">
    <h2 className="sf-h2" id="sf-more-title">
      Mais achados
    </h2>
    <ul className="sf-grid">
      {cards.map((card) => (
        <li key={card.href}>
          <a
            className="sf-card"
            href={card.href}
            onClick={() => recordStorefrontClick(nicheSlug, card.offerId)}
          >
            <span className="sf-card-shot">
              <img src={card.imageUrl} alt="" loading="lazy" decoding="async" />
            </span>
            <span className="sf-card-body">
              <span className="sf-card-title">{card.offerTitle}</span>
              {card.price ? (
                <Price price={card.price} compact />
              ) : (
                <span className="sf-card-price sf-card-none">preço não conferido</span>
              )}
              <span className="sf-card-btn">Ver no Mercado Livre</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  </section>
);

const Follow = ({ handle }: { handle: string }) => (
  <section className="sf-follow" aria-labelledby="sf-follow-title">
    <div>
      <h2 className="sf-follow-title" id="sf-follow-title">
        Os próximos achados saem no Instagram
      </h2>
      <p>@{handle}</p>
    </div>
    <a className="sf-follow-btn" href={instagramUrl(handle)}>
      <Camera size={18} aria-hidden="true" />
      Seguir @{handle}
    </a>
  </section>
);

const Footer = () => (
  <footer className="sf-wrap sf-foot">
    <div>
      <p>Links de afiliado: posso receber comissão pelas compras.</p>
      <p>Preço, estoque e frete são os do Mercado Livre na hora da compra.</p>
    </div>
  </footer>
);

const StateMessage = ({ title, children }: { title: string; children?: ReactNode }) => (
  <main className="sf-wrap">
    <div className="sf-state">
      <h2 className="sf-state-title">{title}</h2>
      {children}
    </div>
  </main>
);

const SKELETON_KEYS = ["s1", "s2", "s3", "s4"];

const Skeleton = () => (
  <>
    <div className="sf-bar" aria-hidden="true">
      <div className="sf-wrap sf-bar-in">
        <div
          className="sf-skel-line"
          style={{ width: 170, height: 44, margin: 0, background: "rgb(255 255 255 / 25%)" }}
        />
      </div>
    </div>
    <main className="sf-wrap" aria-busy="true" aria-label="Carregando achados">
      <div className="sf-hero">
        <div className="sf-skel" style={{ aspectRatio: "4 / 5" }} />
        <div>
          <div className="sf-skel-line" style={{ width: "92%" }} />
          <div className="sf-skel-line" style={{ width: "70%" }} />
          <div className="sf-skel-line" style={{ width: "44%", height: 44, margin: "18px 0" }} />
          <div className="sf-skel-line" style={{ height: 58 }} />
        </div>
      </div>
      <ul className="sf-grid sf-more" aria-hidden="true" style={{ listStyle: "none", padding: 0 }}>
        {SKELETON_KEYS.map((key) => (
          <li key={key}>
            <div className="sf-skel" style={{ aspectRatio: "4 / 5" }} />
          </li>
        ))}
      </ul>
    </main>
  </>
);

const Storefront = ({ data, slug }: { data: StorefrontPayload; slug: string }) => {
  const handle = data.instagramHandle?.replace(/^@/, "") || null;
  const [featured, ...rest] = data.cards;
  return (
    <>
      <TopBar nicheName={data.nicheName} handle={handle} />
      {featured ? (
        <>
          <Strip count={data.cards.length} />
          <main className="sf-wrap">
            <Hero card={featured} nicheSlug={slug} />
            {rest.length ? <Grid cards={rest} nicheSlug={slug} /> : null}
            {handle ? <Follow handle={handle} /> : null}
          </main>
        </>
      ) : (
        <StateMessage title="Novas ofertas em breve.">
          {handle ? (
            <>
              <p>Siga @{handle} para ver os próximos achados assim que saírem.</p>
              <a className="sf-cta" href={instagramUrl(handle)}>
                <Camera size={20} aria-hidden="true" />
                Seguir no Instagram
              </a>
            </>
          ) : null}
        </StateMessage>
      )}
      <Footer />
    </>
  );
};

export const NicheStorefrontRoute = ({ slug, request = fetch }: NicheStorefrontRouteProps) => {
  const [state, setState] = useState<StorefrontState>({ status: "loading" });
  useStorefrontFonts();

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    request(`/v1/public/storefronts/${encodeURIComponent(slug)}`)
      .then(async (response) => {
        if (!active) return;
        if (response.status === 404) return setState({ status: "not_found" });
        if (!response.ok) return setState({ status: "error" });
        const data = readStorefront(await response.json());
        setState(data ? { status: "ready", data } : { status: "error" });
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [request, slug]);

  useEffect(() => {
    if (state.status === "ready")
      document.title = `${state.data.nicheName}: achados do Mercado Livre`;
  }, [state]);

  const accent = state.status === "ready" ? accentFor(state.data.nicheName) : "#1450d6";

  return (
    <div className="sf" style={{ "--accent": accent } as React.CSSProperties}>
      <style>{CSS}</style>
      {state.status === "loading" ? (
        <Skeleton />
      ) : state.status === "not_found" ? (
        <StateMessage title="Esta vitrine não existe.">
          <p>Confira o link que você recebeu.</p>
        </StateMessage>
      ) : state.status === "error" ? (
        <StateMessage title="Não deu para carregar os achados.">
          <p>Tente de novo em instantes.</p>
        </StateMessage>
      ) : (
        <Storefront data={state.data} slug={slug} />
      )}
    </div>
  );
};
