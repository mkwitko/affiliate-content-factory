import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Asset } from "@money-maker/core/assets/asset";
import type { AssetStore } from "@money-maker/core/assets/asset-store";
import type { DesignExporter } from "@money-maker/core/assets/design-exporter";
import type { McpDependencies } from "../server.js";
import { CanvaExportError } from "@money-maker/providers/canva/client";
import { syncCanvaDesignTool } from "./sync-canva-design.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const otherActorId = parseUserId("1997e456-6ea2-430f-8c5e-d98e39430d3e");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const png = async () =>
  sharp({
    create: {
      width: 500,
      height: 400,
      channels: 3,
      background: "#808080",
      noise: { type: "gaussian", mean: 128, sigma: 30 },
    },
  })
    .png()
    .toBuffer();
const blankPng = async () =>
  sharp({ create: { width: 500, height: 400, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();

const baseDependencies = (
  designExporterForWorkspace: NonNullable<McpDependencies["designExporterForWorkspace"]>,
): { dependencies: McpDependencies; puts: Parameters<AssetStore["putObject"]>[0][] } => {
  const puts: Parameters<AssetStore["putObject"]>[0][] = [];
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async ({ userId }) =>
        userId === actorId
          ? { workspaceId, userId, role: "owner" as const, status: "active" as const }
          : null,
      addMembership: async () => undefined,
    },
    assetRepository: {
      create: async (asset: Asset) => asset,
      updateState: async ({ assetId, state }: { assetId: string; state: Asset["state"] }) =>
        ({ id: assetId, state }) as unknown as Asset,
    } as unknown as NonNullable<McpDependencies["assetRepository"]>,
    assetStore: {
      putObject: async (input) => {
        puts.push(input);
      },
    } as AssetStore,
    designExporterForWorkspace,
  };
  return { dependencies, puts };
};

const args = { workspaceId, designId: "design-1", width: 1080, height: 1350 };

describe("sync_canva_design MCP tool", () => {
  it("denies a caller with no workspace membership", async () => {
    const { dependencies } = baseDependencies(() => ({
      exportPages: async () => {
        throw new Error("should not be called");
      },
    }));
    const result = await syncCanvaDesignTool(args, otherActorId, dependencies);
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("returns CANVA_NOT_CONNECTED instead of throwing when the workspace has no connection", async () => {
    const exporter: DesignExporter = {
      exportPages: async () => {
        throw new Error("canva_not_connected");
      },
    };
    const { dependencies } = baseDependencies(() => exporter);
    const result = await syncCanvaDesignTool(args, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "CANVA_NOT_CONNECTED" });
  });

  it.each([
    [new Error("canva_not_connected"), "CANVA_NOT_CONNECTED"],
    [new Error("canva_token_invalid"), "CANVA_TOKEN_INVALID"],
    [new CanvaExportError("canva_token_invalid"), "CANVA_TOKEN_INVALID"],
    [new CanvaExportError("canva_export_timed_out"), "CANVA_EXPORT_TIMED_OUT"],
    [new CanvaExportError("canva_export_failed"), "CANVA_EXPORT_FAILED"],
    [new CanvaExportError("canva_export_request_failed"), "CANVA_EXPORT_FAILED"],
    [new CanvaExportError("canva_export_poll_failed"), "CANVA_EXPORT_FAILED"],
    [new CanvaExportError("canva_export_no_pages"), "CANVA_EXPORT_FAILED"],
    // Canva job error codes are forwarded verbatim inside CanvaExportError.
    [new CanvaExportError("design_not_found"), "CANVA_EXPORT_FAILED"],
    [new Error("page_export_missing"), "CANVA_EXPORT_FAILED"],
    [new Error("invalid_page_selection"), "CANVA_EXPORT_FAILED"],
    // An exported page that fails download or validation (expired URL, wrong type, size).
    [new Error("media_fetch_failed"), "INVALID_CONTENT"],
    [new Error("mime_not_allowed"), "INVALID_CONTENT"],
    [new Error("media_too_large"), "INVALID_CONTENT"],
    [new Error("media_truncated"), "INVALID_CONTENT"],
    [new Error("url_not_public"), "INVALID_CONTENT"],
    [new Error("unsupported_image"), "INVALID_CONTENT"],
    // Anything else (secret store, database) is not the design's fault.
    [new Error("secret_store_unavailable"), "CONNECTION_UNAVAILABLE"],
  ] as const)("maps exporter error %s to %s", async (error, code) => {
    const { dependencies } = baseDependencies(() => ({
      exportPages: async () => {
        throw error;
      },
    }));
    const result = await syncCanvaDesignTool(args, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: code });
  });

  it("maps a network failure before Canva answered to CONNECTION_UNAVAILABLE", async () => {
    const { dependencies } = baseDependencies(() => ({
      exportPages: async () => {
        // Node's fetch rejects with TypeError("fetch failed") when the host is unreachable.
        throw new TypeError("fetch failed");
      },
    }));
    const result = await syncCanvaDesignTool(args, actorId, dependencies);
    expect(result).toEqual({ ok: false, error: "CONNECTION_UNAVAILABLE" });
  });

  it("letterboxes each exported page onto the requested canvas and stores it as a workspace asset", async () => {
    const bytes = await png();
    const exporter: DesignExporter = {
      exportPages: async (input) =>
        input.pages.map((page) => ({
          page,
          bytes,
          mimeType: "image/png" as const,
          width: 500,
          height: 400,
          expiresAt: new Date(Date.now() + 60_000),
        })),
    };
    const { dependencies, puts } = baseDependencies(() => exporter);

    const result = await syncCanvaDesignTool(args, actorId, dependencies);

    expect(result.ok).toBe(true);
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ mimeType: "image/jpeg", width: 1080, height: 1350 });
    if (result.ok) expect(result.value).toMatchObject({ designId: "design-1" });
  });

  it("refuses a blank page before storing any asset", async () => {
    const [filled, blank] = await Promise.all([png(), blankPng()]);
    const exporter: DesignExporter = {
      exportPages: async (input) =>
        input.pages.map((page) => ({
          page,
          bytes: page === 1 ? blank : filled,
          mimeType: "image/png" as const,
          width: 500,
          height: 400,
          expiresAt: new Date(Date.now() + 60_000),
        })),
    };
    const { dependencies, puts } = baseDependencies(() => exporter);

    const result = await syncCanvaDesignTool({ ...args, pages: [1, 2] }, actorId, dependencies);

    expect(result).toEqual({ ok: false, error: "CANVA_PAGE_BLANK" });
    expect(puts).toHaveLength(0);
  });

  it("defaults to the first page when pages is omitted", async () => {
    const bytes = await png();
    let requestedPages: readonly number[] = [];
    const exporter: DesignExporter = {
      exportPages: async (input) => {
        requestedPages = input.pages;
        return input.pages.map((page) => ({
          page,
          bytes,
          mimeType: "image/png" as const,
          width: 500,
          height: 400,
          expiresAt: new Date(Date.now() + 60_000),
        }));
      },
    };
    const { dependencies } = baseDependencies(() => exporter);

    await syncCanvaDesignTool(args, actorId, dependencies);

    expect(requestedPages).toEqual([1]);
  });
});
