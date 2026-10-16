/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ProviderConnectionClient,
  ProviderConnectionCreateError,
  ProviderConnectionForm,
} from "./provider-connection-form.js";

const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;

const renderForm = (
  client: ProviderConnectionClient,
  canManage = true,
): { container: HTMLDivElement; root: Root } => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ProviderConnectionForm client={client} canManage={canManage} />);
  });
  return { container, root };
};

const setInputValue = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ProviderConnectionForm", () => {
  it("clears the API key and account label after a successful connection", async () => {
    const client: ProviderConnectionClient = { create: vi.fn(async () => undefined) };
    const { container, root } = renderForm(client);
    const apiKeyInput = container.querySelector("input[aria-label='Post For Me API key']");
    const accountInput = container.querySelector("input[aria-label='Instagram account label']");
    if (!(apiKeyInput instanceof HTMLInputElement) || !(accountInput instanceof HTMLInputElement)) {
      throw new Error("Expected API key and account inputs");
    }

    await setInputValue(apiKeyInput, "pfm_secret_test");
    await setInputValue(accountInput, "ig-account-one");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
      await Promise.resolve();
    });

    expect(client.create).toHaveBeenCalledWith("pfm_secret_test", "ig-account-one");
    expect(apiKeyInput.value).toBe("");
    expect(accountInput.value).toBe("");
    root.unmount();
  });

  it("also clears the API key when the connection request fails", async () => {
    const client: ProviderConnectionClient = {
      create: vi.fn(async () => {
        throw new Error("connection_failed");
      }),
    };
    const { container, root } = renderForm(client);
    const apiKeyInput = container.querySelector("input[aria-label='Post For Me API key']");
    const accountInput = container.querySelector("input[aria-label='Instagram account label']");
    if (!(apiKeyInput instanceof HTMLInputElement) || !(accountInput instanceof HTMLInputElement)) {
      throw new Error("Expected API key and account inputs");
    }

    await setInputValue(apiKeyInput, "pfm_secret_test");
    await setInputValue(accountInput, "ig-account-one");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
      await Promise.resolve();
    });

    expect(apiKeyInput.value).toBe("");
    expect(accountInput.value).toBe("");
    expect(container.textContent).not.toContain("pfm_secret_test");
    expect(container.textContent).toContain("A chave de API foi apagada");
    root.unmount();
  });

  it("shows a pt-BR message for an invalid API key", async () => {
    const client: ProviderConnectionClient = {
      create: vi.fn(async () => {
        throw new ProviderConnectionCreateError("invalid_api_key");
      }),
    };
    const { container, root } = renderForm(client);
    const apiKeyInput = container.querySelector("input[aria-label='Post For Me API key']");
    const accountInput = container.querySelector("input[aria-label='Instagram account label']");
    if (!(apiKeyInput instanceof HTMLInputElement) || !(accountInput instanceof HTMLInputElement)) {
      throw new Error("Expected API key and account inputs");
    }

    await setInputValue(apiKeyInput, "pfm_bad_key");
    await setInputValue(accountInput, "ig-account-one");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Chave de API inválida");
    root.unmount();
  });

  it("lists the available accounts in pt-BR when the handle isn't found", async () => {
    const client: ProviderConnectionClient = {
      create: vi.fn(async () => {
        throw new ProviderConnectionCreateError("account_not_found", [
          "exampleshop.beleza",
          "exampleshop.tech",
        ]);
      }),
    };
    const { container, root } = renderForm(client);
    const apiKeyInput = container.querySelector("input[aria-label='Post For Me API key']");
    const accountInput = container.querySelector("input[aria-label='Instagram account label']");
    if (!(apiKeyInput instanceof HTMLInputElement) || !(accountInput instanceof HTMLInputElement)) {
      throw new Error("Expected API key and account inputs");
    }

    await setInputValue(apiKeyInput, "pfm_secret_test");
    await setInputValue(accountInput, "unknown-handle");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button[type=submit]")?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("não encontrada");
    expect(container.textContent).toContain("@exampleshop.beleza");
    expect(container.textContent).toContain("@exampleshop.tech");
    root.unmount();
  });

  it("hides secret controls from reviewers", () => {
    const client: ProviderConnectionClient = { create: vi.fn(async () => undefined) };
    const { container, root } = renderForm(client, false);

    expect(container.querySelector("input[aria-label='Post For Me API key']")).toBeNull();
    expect(container.querySelector("input[aria-label='Instagram account label']")).toBeNull();
    expect(container.textContent).toContain(
      "Somente proprietários e operadores podem alterar esta conexão.",
    );
    root.unmount();
  });

  it("allows only one request while a connection is pending", async () => {
    let resolve: (() => void) | undefined;
    const client: ProviderConnectionClient = {
      create: vi.fn(
        () =>
          new Promise<void>((finish) => {
            resolve = finish;
          }),
      ),
    };
    const { container, root } = renderForm(client);
    const apiKeyInput = container.querySelector("input[aria-label='Post For Me API key']");
    const accountInput = container.querySelector("input[aria-label='Instagram account label']");
    if (!(apiKeyInput instanceof HTMLInputElement) || !(accountInput instanceof HTMLInputElement)) {
      throw new Error("Expected API key and account inputs");
    }
    await setInputValue(apiKeyInput, "pfm_secret_test");
    await setInputValue(accountInput, "ig-account-one");
    const button = container.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!button) throw new Error("Expected connect button");

    await act(async () => {
      button.click();
      button.click();
      await Promise.resolve();
    });

    expect(client.create).toHaveBeenCalledTimes(1);
    resolve?.();
    await act(async () => {
      await Promise.resolve();
    });
    root.unmount();
  });
});
