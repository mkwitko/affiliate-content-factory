/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvaConnectionPanel } from "./canva-connection-panel.js";

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
    root.render(<CanvaConnectionPanel workspaceId="workspace-1" role={role} request={request} />);
  });
  return { container, root };
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CanvaConnectionPanel", () => {
  it("shows the account and clears the one-time success flag from the URL", async () => {
    window.history.replaceState(null, "", "/?canva_connected=1");
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            connections: [
              {
                id: "canva-1",
                provider: "canva",
                mode: "oauth",
                status: "active",
                accountId: "user-1",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root } = renderPanel(request);

    await flushPromises();

    expect(container.textContent).toContain("user-1");
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
                provider: "canva",
                mode: "oauth",
                status: "active",
                accountId: "user-1",
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();

    expect(container.querySelector("button[data-action='disconnect-canva']")).not.toBeNull();
    root.unmount();
  });

  it("offers a connect button when no connection exists", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(request);

    await flushPromises();

    expect(container.querySelector("button[data-action='connect-canva']")).not.toBeNull();
    root.unmount();
  });

  it("does not offer connect controls to reviewers", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ connections: [] }), { status: 200 }),
    );
    const { container, root }: { container: HTMLDivElement; root: Root } = renderPanel(
      request,
      "reviewer",
    );

    await flushPromises();

    expect(container.querySelector("button[data-action='connect-canva']")).toBeNull();
    root.unmount();
  });
});
