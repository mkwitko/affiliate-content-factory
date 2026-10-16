/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceSwitcher } from "./workspace-switcher.js";

const workspaces = [
  { id: "workspace-a", name: "Workspace Alpha", role: "operator" as const },
  { id: "workspace-b", name: "Workspace Beta", role: "reviewer" as const },
];

describe("WorkspaceSwitcher", () => {
  it("shows named authorized workspaces and resets selection through the callback", () => {
    const onChange = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorkspaceSwitcher
          workspaces={workspaces}
          selectedWorkspaceId="workspace-a"
          onChange={onChange}
        />,
      ),
    );
    expect(container.textContent).toContain("Workspace Alpha — operador");
    expect(container.textContent).toContain("Workspace Beta — revisor");
    const select = container.querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("Expected workspace selector");
    act(() => {
      select.value = "workspace-b";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("workspace-b");
    root.unmount();
  });

  it("does not render a stale workspace outside the authorized response", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorkspaceSwitcher
          workspaces={workspaces}
          selectedWorkspaceId="workspace-a"
          onChange={vi.fn()}
        />,
      ),
    );
    expect(container.textContent).not.toContain("Workspace Gamma");
    root.unmount();
  });
});
