/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthenticatedShell } from "./authenticated-shell.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const renderShell = (request: typeof fetch): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AuthenticatedShell request={request}>
        <p>Private workspace</p>
      </AuthenticatedShell>,
    );
  });
  return { container, root };
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AuthenticatedShell", () => {
  it("shows a login action when the browser has no session", async () => {
    const request = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ authenticated: false }), { status: 200 }),
    );
    const { container, root } = renderShell(request);

    await flushPromises();

    expect(container.textContent).toContain("Entrar");
    expect(container.querySelector("a[href='/v1/auth/login']")).toBeTruthy();
    expect(container.textContent).not.toContain("Private workspace");
    root.unmount();
  });

  it("renders private content only after the session is authenticated", async () => {
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input) === "/v1/me/workspaces"
        ? new Response(JSON.stringify({ workspaces: [] }), { status: 200 })
        : new Response(
            JSON.stringify({
              authenticated: true,
              user: { id: "user-1", email: "owner@example.com" },
            }),
            { status: 200 },
          ),
    );
    const { container, root } = renderShell(request);

    await flushPromises();

    expect(container.textContent).toContain("Private workspace");
    expect(container.textContent).toContain("owner@example.com");
    root.unmount();
  });

  it("logs out through the same-origin cookie endpoint", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            user: { id: "user-1", email: "owner@example.com" },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ workspaces: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { container, root } = renderShell(request);

    await flushPromises();
    const logout = container.querySelector("button[data-action=logout]");
    if (!(logout instanceof HTMLButtonElement)) throw new Error("Expected logout button");

    await act(async () => {
      logout.click();
      await Promise.resolve();
    });

    expect(request).toHaveBeenLastCalledWith(
      "/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { origin: window.location.origin },
      }),
    );
    expect(container.textContent).toContain("Entrar");
    root.unmount();
  });
});
