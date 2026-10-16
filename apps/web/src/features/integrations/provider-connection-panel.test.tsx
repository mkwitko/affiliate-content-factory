/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderConnectionPanel } from "./provider-connection-panel.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const renderPanel = (
  request: typeof fetch,
  role: "owner" | "operator" | "reviewer" = "owner",
): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ProviderConnectionPanel workspaceId="workspace-1" role={role} request={request} />,
    );
  });
  return { container, root };
};

const expandAccordionItem = async (container: HTMLDivElement, index: number): Promise<void> => {
  const trigger = container.querySelectorAll<HTMLButtonElement>("summary");
  await act(async () => {
    trigger[index]?.click();
    await Promise.resolve();
  });
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProviderConnectionPanel", () => {
  it("shows a redacted connection without exposing secret references", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "connection-1",
                provider: "post_for_me",
                mode: "api_key",
                status: "active",
                accountId: "default",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("Conectada");
    expect(container.textContent).not.toContain("secretReference");
    expect(container.textContent).not.toContain("pfm_secret_test");
    root.unmount();
  });

  it("renders each Instagram account as its own accordion item next to the add-account card", async () => {
    const connection = (accountId: string) => ({
      id: `connection-${accountId}`,
      provider: "post_for_me",
      mode: "api_key",
      status: "active",
      accountId,
    });
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              connection("exampleshop.home"),
              connection("exampleshop.beleza"),
              connection("exampleshop.tech"),
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    const triggers = [...container.querySelectorAll("summary")].map((node) => node.textContent);
    expect(triggers).toEqual([
      "@exampleshop.homeConectada",
      "@exampleshop.belezaConectada",
      "@exampleshop.techConectada",
    ]);
    expect(container.textContent).toContain("Adicionar conta do Instagram");
    root.unmount();
  });

  it("offers one pre-filled card per niche that has no Instagram account connected", async () => {
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/operator-context")
        ? new Response(
            JSON.stringify({
              niches: [
                { id: "n1", name: "Example Shop Beleza" },
                { id: "n2", name: "Example Shop Home" },
              ],
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              connections: [
                {
                  id: "c1",
                  provider: "post_for_me",
                  mode: "api_key",
                  status: "active",
                  accountId: "spc_casa",
                  displayName: "exampleshop.home",
                },
              ],
            }),
            { status: 200 },
          ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();
    await flushPromises();

    const handles = [
      ...container.querySelectorAll<HTMLInputElement>(
        "input[aria-label='Instagram account label']",
      ),
    ].map((input) => input.value);
    expect(handles).toContain("exampleshop.beleza");
    expect(handles).not.toContain("exampleshop.home");
    expect(container.textContent).toContain("Example Shop Beleza");
    root.unmount();
  });

  it("ignores other providers' connections and still offers all niche cards", async () => {
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/operator-context")
        ? new Response(
            JSON.stringify({
              niches: [
                { id: "n1", name: "Example Shop Beleza" },
                { id: "n2", name: "Example Shop Home" },
                { id: "n3", name: "Example Shop Tech" },
              ],
            }),
            { status: 200 },
          )
        : new Response(
            JSON.stringify({
              connections: [
                {
                  id: "ml-1",
                  provider: "mercado_livre",
                  mode: "oauth",
                  status: "active",
                  accountId: "1133343639",
                },
              ],
            }),
            { status: 200 },
          ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();
    await flushPromises();

    expect(container.textContent).not.toContain("Não foi possível carregar");
    expect(container.textContent).not.toContain("1133343639");
    const handles = [
      ...container.querySelectorAll<HTMLInputElement>(
        "input[aria-label='Instagram account label']",
      ),
    ].map((input) => input.value);
    expect(handles).toEqual(
      expect.arrayContaining(["exampleshop.beleza", "exampleshop.home", "exampleshop.tech"]),
    );
    root.unmount();
  });

  it("asks for confirmation before revoking a connection", async () => {
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/operator-context")
        ? new Response(null, { status: 404 })
        : new Response(
            JSON.stringify({
              connections: [
                {
                  id: "connection-1",
                  provider: "post_for_me",
                  mode: "api_key",
                  status: "active",
                  accountId: "default",
                },
              ],
            }),
            { status: 200 },
          ),
    );
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { container, root } = renderPanel(request);

    await flushPromises();
    await expandAccordionItem(container, 0);
    const revoke = container.querySelector<HTMLButtonElement>("button[data-action='revoke']");
    if (!revoke) throw new Error("Expected revoke button");
    await act(async () => {
      revoke.click();
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalled();
    const connectionCalls = request.mock.calls.filter(
      ([input]) => !String(input).endsWith("/operator-context"),
    );
    expect(connectionCalls).toHaveLength(1);
    root.unmount();
  });

  it("shows every connection and still offers the form to add another account", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "connection-1",
                provider: "post_for_me",
                mode: "api_key",
                status: "active",
                accountId: "ig-account-one",
              },
              {
                id: "connection-2",
                provider: "post_for_me",
                mode: "api_key",
                status: "active",
                accountId: "ig-account-two",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("ig-account-one");
    expect(container.textContent).toContain("ig-account-two");
    expect(container.querySelector("input[aria-label='Instagram account label']")).not.toBeNull();
    root.unmount();
  });

  it("shows the display name with a fallback to the account id", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "connection-1",
                provider: "post_for_me",
                mode: "api_key",
                status: "active",
                accountId: "acc-123",
                displayName: "exampleshop.home",
              },
              {
                id: "connection-2",
                provider: "post_for_me",
                mode: "api_key",
                status: "active",
                accountId: "acc-456",
                displayName: null,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("@exampleshop.home");
    expect(container.textContent).toContain("@acc-456");
    root.unmount();
  });

  it("tests a Post For Me connection and shows that it works", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/test") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: true,
            account: "@exampleshop.home",
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
              provider: "post_for_me",
              mode: "api_key",
              status: "active",
              accountId: "acc-123",
              displayName: "exampleshop.home",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const { container, root } = renderPanel(request);

    await flushPromises();
    await expandAccordionItem(container, 0);
    const testButton = container.querySelector<HTMLButtonElement>(
      "button[data-action='test-connection']",
    );
    if (!testButton) throw new Error("Expected test-connection button");
    await act(async () => {
      testButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Funcionando");
    root.unmount();
  });

  it("shows the pt-BR reason when a Post For Me connection test fails", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/test") && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            ok: false,
            reason: "invalid_api_key",
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
              provider: "post_for_me",
              mode: "api_key",
              status: "active",
              accountId: "acc-123",
              displayName: "exampleshop.home",
            },
          ],
        }),
        { status: 200 },
      );
    });
    const { container, root } = renderPanel(request);

    await flushPromises();
    await expandAccordionItem(container, 0);
    const testButton = container.querySelector<HTMLButtonElement>(
      "button[data-action='test-connection']",
    );
    if (!testButton) throw new Error("Expected test-connection button");
    await act(async () => {
      testButton.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Chave inválida");
    root.unmount();
  });

  it("does not render mutation controls for reviewers", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    const { container, root } = renderPanel(request, "reviewer");

    await flushPromises();

    expect(container.querySelector("input[aria-label='Post For Me API key']")).toBeNull();
    expect(container.querySelector("button[data-action='revoke']")).toBeNull();
    root.unmount();
  });
});
