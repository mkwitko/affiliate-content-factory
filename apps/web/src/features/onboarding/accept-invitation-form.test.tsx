/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcceptInvitationForm,
  createInvitationAcceptanceClient,
  type InvitationAcceptanceClient,
  type InvitationAcceptanceResult,
} from "./accept-invitation-form.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const flushPromises = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

const renderForm = (
  client: InvitationAcceptanceClient,
): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AcceptInvitationForm token="valid-token" client={client} />);
  });
  return { container, root };
};

const submitForm = async (
  container: HTMLDivElement,
  email = "person@example.com",
): Promise<void> => {
  const form = container.querySelector("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Expected invitation form");
  const emailInput = form.elements.namedItem("email");
  if (!(emailInput instanceof HTMLInputElement)) throw new Error("Expected email input");
  emailInput.value = email;
  await act(async () => {
    form.requestSubmit();
  });
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AcceptInvitationForm", () => {
  it("shows a loading state while acceptance is pending", async () => {
    let resolveAcceptance:
      | ((value: { status: "accepted"; invitationId: string }) => void)
      | undefined;
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(
        (_token, _email) =>
          new Promise<InvitationAcceptanceResult>((resolve) => {
            resolveAcceptance = resolve;
          }),
      ),
    };
    const { container, root } = renderForm(client);

    await submitForm(container);

    expect(container.textContent).toContain("Aceitando");
    expect(container.querySelector("button[type=submit]")).toHaveProperty("disabled", true);

    await act(async () => {
      resolveAcceptance?.({ status: "accepted", invitationId: "invitation-1" });
    });
    root.unmount();
  });

  it.each([
    ["INVITATION_NOT_FOUND", "Este convite é inválido ou não está mais disponível."],
    ["INVITATION_EXPIRED", "Este convite expirou. Peça um novo a quem administra o espaço."],
  ] as const)("shows a safe message for %s", async (code, message) => {
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(async () => {
        throw { code };
      }),
    };
    const { container, root } = renderForm(client);

    await submitForm(container);
    await flushPromises();

    expect(container.textContent).toContain(message);
    root.unmount();
  });

  it("shows the empty workspace shell after successful acceptance", async () => {
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(async () => ({
        status: "accepted",
        invitationId: "invitation-1",
      })),
    };
    const { container, root } = renderForm(client);

    await submitForm(container);
    await flushPromises();

    expect(container.querySelector("h1")?.textContent).toBe("Seu espaço está pronto");
    expect(container.textContent).toContain("Abrir o painel");
    root.unmount();
  });

  it("submits with the keyboard from the email field", async () => {
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(async () => ({
        status: "accepted",
        invitationId: "invitation-1",
      })),
    };
    const { container, root } = renderForm(client);
    const emailInput = container.querySelector("input[name=email]");
    if (!(emailInput instanceof HTMLInputElement)) throw new Error("Expected email input");
    emailInput.value = "person@example.com";

    await act(async () => {
      emailInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushPromises();

    expect(client.accept).toHaveBeenCalledWith("valid-token", "person@example.com");
    root.unmount();
  });

  it("does not submit an invalid email from the keyboard", async () => {
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(async () => ({
        status: "accepted",
        invitationId: "invitation-1",
      })),
    };
    const { container, root } = renderForm(client);
    const emailInput = container.querySelector("input[name=email]");
    if (!(emailInput instanceof HTMLInputElement)) throw new Error("Expected email input");
    emailInput.value = "not-an-email";

    await act(async () => {
      emailInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushPromises();

    expect(client.accept).not.toHaveBeenCalled();
    root.unmount();
  });

  it("prevents double submission while the request is pending", async () => {
    let resolveAcceptance:
      | ((value: { status: "accepted"; invitationId: string }) => void)
      | undefined;
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(
        (_token, _email) =>
          new Promise<InvitationAcceptanceResult>((resolve) => {
            resolveAcceptance = resolve;
          }),
      ),
    };
    const { container, root } = renderForm(client);

    const form = container.querySelector("form");
    if (!(form instanceof HTMLFormElement)) throw new Error("Expected invitation form");
    const emailInput = form.elements.namedItem("email");
    if (!(emailInput instanceof HTMLInputElement)) throw new Error("Expected email input");
    emailInput.value = "person@example.com";
    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
    });

    expect(client.accept).toHaveBeenCalledTimes(1);
    expect(form.querySelector("button[type=submit]")).toHaveProperty("disabled", true);
    await act(async () => {
      resolveAcceptance?.({ status: "accepted", invitationId: "invitation-1" });
    });
    root.unmount();
  });

  it("offers a recovery action after a transient API error", async () => {
    const client: InvitationAcceptanceClient = {
      accept: vi
        .fn<InvitationAcceptanceClient["accept"]>()
        .mockRejectedValueOnce(new Error("Network unavailable"))
        .mockResolvedValueOnce({ status: "accepted", invitationId: "invitation-1" }),
    };
    const { container, root } = renderForm(client);

    await submitForm(container);
    await flushPromises();

    expect(container.textContent).toContain("Não deu para aceitar o convite.");
    const retry = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Tentar de novo"),
    );
    if (!(retry instanceof HTMLButtonElement)) throw new Error("Expected retry button");

    await act(async () => {
      retry.click();
    });
    await flushPromises();

    expect(container.querySelector("h1")?.textContent).toBe("Seu espaço está pronto");
    expect(client.accept).toHaveBeenCalledTimes(2);
    root.unmount();
  });

  it("offers a recovery action for an internal API error", async () => {
    const client: InvitationAcceptanceClient = {
      accept: vi.fn<InvitationAcceptanceClient["accept"]>(async () => {
        throw { code: "INTERNAL_ERROR" };
      }),
    };
    const { container, root } = renderForm(client);

    await submitForm(container);
    await flushPromises();

    expect(container.textContent).toContain("Não deu para aceitar o convite.");
    expect(container.textContent).toContain("Tentar de novo");
    root.unmount();
  });

  it("rejects a successful response with an unknown invitation status", async () => {
    const request = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ invitationId: "invitation-1", status: "unexpected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createInvitationAcceptanceClient(request);

    await expect(client.accept("valid-token", "person@example.com")).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });
});
