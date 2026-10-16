/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MercadoLivreConnectionPanel } from "./mercado-livre-connection-panel.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const renderPanel = (request: typeof fetch, role: "owner" | "operator" | "reviewer" = "owner") => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MercadoLivreConnectionPanel workspaceId="workspace-1" role={role} request={request} />,
    );
  });
  return { container, root };
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("MercadoLivreConnectionPanel", () => {
  it("shows the nickname and clears the one-time success flag from the URL", async () => {
    window.history.replaceState(null, "", "/?mercado_livre_connected=1");
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "ml-1",
                provider: "mercado_livre",
                mode: "oauth",
                status: "active",
                accountId: "1133343639",
                displayName: "LOJA_VALEACOMPRA",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("LOJA_VALEACOMPRA");
    expect(container.textContent).toContain("conectada com sucesso");
    expect(window.location.search).toBe("");
    root.unmount();
  });

  it("shows the connected account and a disconnect button", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "connection-1",
                provider: "mercado_livre",
                mode: "oauth",
                status: "active",
                accountId: "123456",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("123456");
    expect(
      container.querySelector("button[data-action='disconnect-mercado-livre']"),
    ).not.toBeNull();
    root.unmount();
  });

  it("tests the Mercado Livre connection and shows that it works", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/test") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            account: "LOJA_OFICIAL",
            checkedAt: "2026-09-23T10:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          connections: [
            {
              id: "connection-1",
              provider: "mercado_livre",
              mode: "oauth",
              status: "active",
              accountId: "123456",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();
    const testButton = container.querySelector<HTMLButtonElement>(
      "button[data-action='test-mercado-livre']",
    );
    if (!testButton) throw new Error("Expected test button");
    await act(async () => {
      testButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Funcionando");
    root.unmount();
  });

  it("shows a pt-BR reason when the Mercado Livre connection needs reconnecting", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/test") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: false,
            reason: "reconnect_required",
            checkedAt: "2026-09-23T10:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          connections: [
            {
              id: "connection-1",
              provider: "mercado_livre",
              mode: "oauth",
              status: "active",
              accountId: "123456",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();
    const testButton = container.querySelector<HTMLButtonElement>(
      "button[data-action='test-mercado-livre']",
    );
    if (!testButton) throw new Error("Expected test button");
    await act(async () => {
      testButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Reconecte o Mercado Livre");
    root.unmount();
  });

  it("offers the app-credential form when no connection exists", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();

    expect(container.querySelector("input[aria-label='Mercado Livre App ID']")).not.toBeNull();
    expect(container.querySelector("input[aria-label='Mercado Livre App Secret']")).not.toBeNull();
    root.unmount();
  });

  it("does not offer credential controls to reviewers", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(
      request,
      "reviewer",
    );

    await flushPromises();

    expect(container.querySelector("input[aria-label='Mercado Livre App ID']")).toBeNull();
    root.unmount();
  });
});
