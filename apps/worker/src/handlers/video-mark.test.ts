import { describe, expect, it, vi } from "vitest";
import { loadVideoMark } from "./video-mark.js";

const workspaceId = "0d7702aa-a69d-4f49-842a-c1a13e72160d" as never;
const plan = {
  opacity: 0.6,
  position: "top-left" as const,
  minWidth: 160,
  safeMargin: 0.06,
  logoLightAssetId: "logo-1",
};

describe("loadVideoMark", () => {
  it("returns nothing without a plan", async () => {
    const assets = { findForWorkspace: vi.fn() };
    expect(
      await loadVideoMark({
        plan: undefined,
        workspaceId,
        assets,
        store: { createDownload: vi.fn() },
      }),
    ).toBeUndefined();
    expect(assets.findForWorkspace).not.toHaveBeenCalled();
  });

  it("skips logos that are inactive or lack commercial rights, without failing", async () => {
    const createDownload = vi.fn();
    for (const asset of [
      { id: "logo-1", state: "pending", commercialUse: true },
      { id: "logo-1", state: "active", commercialUse: null },
      null,
    ]) {
      const result = await loadVideoMark({
        plan,
        workspaceId,
        assets: { findForWorkspace: vi.fn(async () => asset as never) },
        store: { createDownload },
      });
      expect(result).toBeUndefined();
    }
    expect(createDownload).not.toHaveBeenCalled();
  });

  it("drops a logo whose download fails", async () => {
    const result = await loadVideoMark({
      plan,
      workspaceId,
      assets: {
        findForWorkspace: vi.fn(
          async () => ({ id: "logo-1", state: "active", commercialUse: true }) as never,
        ),
      },
      store: { createDownload: vi.fn(async () => Promise.reject(new Error("boom"))) },
    });
    expect(result).toBeUndefined();
  });
});
