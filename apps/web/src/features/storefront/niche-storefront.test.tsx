/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NicheStorefrontRoute } from "./niche-storefront.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const renderRoute = (request: typeof fetch): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<NicheStorefrontRoute slug="tech-ab12" request={request} />);
  });
  return { container, root };
};

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
  vi.restoreAllMocks();
});

describe("NicheStorefrontRoute", () => {
  it("shows a loading skeleton before the fetch resolves", () => {
    const request = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const { container, root } = renderRoute(request);

    expect(container.querySelectorAll(".sf-skel").length).toBeGreaterThan(0);
    root.unmount();
  });

  const respond = (body: unknown) =>
    vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
  const text = (container: HTMLElement) => (container.textContent ?? "").replace(/\s/g, " ");

  it("features the newest offer with a price read from Mercado Livre and grids the rest", async () => {
    const request = respond({
      nicheName: "Example Shop Tech",
      instagramHandle: "tech.achados",
      cards: [
        {
          offerId: "offer-1",
          offerTitle: "Suporte de notebook",
          imageUrl: "https://cdn.example/a1.jpg",
          href: "https://meli.la/abc",
          price: { amountMinor: 12990, currency: "BRL" },
          listPrice: { amountMinor: 15990, currency: "BRL" },
          priceVerifiedAt: "2026-09-24T17:30:00Z",
        },
        {
          offerId: "offer-2",
          offerTitle: "Mouse sem fio",
          imageUrl: "https://cdn.example/a2.jpg",
          href: "https://meli.la/legacy",
        },
      ],
    });
    const { container, root } = renderRoute(request);

    await flushPromises();

    expect(request).toHaveBeenCalledWith("/v1/public/storefronts/tech-ab12");
    const cta = container.querySelector<HTMLAnchorElement>(".sf-cta");
    expect(cta?.textContent).toBe("Comprar no Mercado Livre");
    expect(cta?.getAttribute("href")).toBe("https://meli.la/abc");
    expect(container.querySelector(".sf-hero img")?.getAttribute("loading")).toBe("eager");
    // 17:30 UTC is 14:30 in São Paulo.
    expect(text(container)).toContain("R$ 129,90");
    expect(container.querySelector(".sf-hero s")?.textContent?.replace(/\s/g, " ")).toBe(
      "de R$ 159,90",
    );
    expect(text(container)).toContain("no Mercado Livre em 24/09 às 14h");

    const gridLinks = container.querySelectorAll(".sf-grid a");
    expect(gridLinks).toHaveLength(1);
    expect(gridLinks[0]?.getAttribute("href")).toBe("https://meli.la/legacy");
    expect(gridLinks[0]?.textContent).toContain("Ver no Mercado Livre");
    expect(gridLinks[0]?.querySelector(".sf-chip")).toBeNull();
    expect(container.querySelector(".sf-grid img")?.getAttribute("loading")).toBe("lazy");

    expect(container.querySelector(".sf-bar")?.textContent).toContain("Tech");
    expect(
      container.querySelectorAll("a[href='https://www.instagram.com/tech.achados/']"),
    ).toHaveLength(2);
    expect(text(container)).toContain("Links de afiliado: posso receber comissão pelas compras.");
    expect(document.title).toBe("Example Shop Tech: achados do Mercado Livre");
    root.unmount();
  });

  it("asks the visitor to check the price on Mercado Livre when none is fresh, with no follow CTA without a handle", async () => {
    const { container, root } = renderRoute(
      respond({
        nicheName: "Example Shop Home",
        instagramHandle: null,
        cards: [
          {
            offerId: "offer-1",
            offerTitle: "Organizador",
            imageUrl: "https://cdn.example/a.jpg",
            href: "https://meli.la/a",
          },
        ],
      }),
    );

    await flushPromises();

    expect(text(container)).toContain("Veja o preço de agora no Mercado Livre.");
    expect(text(container)).not.toContain("R$");
    expect(container.querySelector(".sf-grid")).toBeNull();
    expect(container.querySelector("a[href^='https://www.instagram.com/']")).toBeNull();
    root.unmount();
  });

  it("logs clicks with a beacon while leaving the affiliate link as the anchor href", async () => {
    const sendBeacon = vi
      .fn<(url: string, data: BodyInit | null) => boolean>()
      .mockReturnValue(true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    const { container, root } = renderRoute(
      respond({
        nicheName: "Tech",
        instagramHandle: null,
        cards: [
          {
            offerId: "offer-1",
            offerTitle: "Lamp",
            imageUrl: "https://cdn.example/a.jpg",
            href: "https://meli.la/abc",
          },
        ],
      }),
    );

    await flushPromises();
    const cta = container.querySelector<HTMLAnchorElement>(".sf-cta");
    expect(cta?.href).toBe("https://meli.la/abc");
    act(() => cta?.click());

    expect(sendBeacon).toHaveBeenCalledWith("/v1/public/clicks", expect.any(Blob));
    const body = sendBeacon.mock.calls.at(0)?.[1];
    expect(body).toBeInstanceOf(Blob);
    if (!(body instanceof Blob)) throw new Error("Click beacon body must be a Blob");
    const payload = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(body);
    });
    expect(payload).toBe(JSON.stringify({ nicheSlug: "tech-ab12", offerId: "offer-1" }));
    root.unmount();
  });

  it("shows the empty state with a button to follow the handle", async () => {
    const { container, root } = renderRoute(
      respond({ nicheName: "Tech", instagramHandle: "tech.achados", cards: [] }),
    );

    await flushPromises();

    expect(container.textContent).toContain("Novas ofertas em breve.");
    expect(container.textContent).toContain("Siga @tech.achados para ver os próximos achados");
    const cta = container.querySelector(
      ".sf-state a[href='https://www.instagram.com/tech.achados/']",
    );
    expect(cta?.textContent).toBe("Seguir no Instagram");
    expect(container.querySelector(".sf-hero")).toBeNull();
    root.unmount();
  });

  it("shows a 404 state for an unknown niche slug", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));
    const { container, root } = renderRoute(request);

    await flushPromises();

    expect(container.textContent).toContain("Esta vitrine não existe.");
    root.unmount();
  });
});
