import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import { recordTikTokShopStatus } from "@money-maker/core/channels/tiktok-shop-status";
import type { McpDependencies } from "../server.js";
import { getTikTokShopStatusTool } from "./get-tiktok-shop-status.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const now = new Date("2026-09-28T12:00:00.000Z");

const workspaces = (role: "owner" | "operator" | "reviewer" | "other"): WorkspaceRepository => ({
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () =>
    role === "other" ? null : { workspaceId, userId: actorId, role, status: "active" },
  addMembership: async () => undefined,
});

const tiktokChannel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "tiktok_video",
  label: "TikTok",
  status: "active",
  capabilities: {
    maxAssets: 1,
    requiresOrderedAssets: false,
    allowedMimeTypes: ["video/mp4"],
    captionMaxLength: 2200,
    requiredAssetDimensions: { width: 1080, height: 1920 },
  },
};

const fixture = (
  channel: Channel | null,
  role: "owner" | "operator" | "reviewer" | "other" = "reviewer",
): McpDependencies => {
  const channelRepository: ChannelRepository = {
    create: async (value) => value,
    findForWorkspace: async () => channel,
    updateStatus: async () => null,
  };
  return {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: workspaces(role),
    channelRepository,
  };
};

describe("get_tiktok_shop_status MCP tool", () => {
  it("reports UNKNOWN with the exact message when no status was ever recorded", async () => {
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture(tiktokChannel),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        state: "unknown",
        effectiveState: "unknown",
        stale: false,
        observedAt: null,
        reason: null,
        bioLinkAvailable: null,
        track: "manual_diagnosis",
        strategy: "grow_audience",
        inAppPath: "Perfil → menu → TikTok Studio → TikTok Shop para criadores",
        message: "TikTok Shop status: UNKNOWN — automatic verification unavailable",
      },
    });
  });

  it("reports a recorded shop_enabled status with its track", async () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    const channel = { ...tiktokChannel, context: { tiktokShop: status } };
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture(channel),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        state: "shop_enabled",
        effectiveState: "shop_enabled",
        stale: false,
        track: "selling",
        strategy: "sell_tiktok_shop",
      },
    });
  });

  it("reports stale when the recorded status is older than 30 days", async () => {
    const status = recordTikTokShopStatus(
      null,
      { state: "shop_enabled" },
      new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
    );
    const channel = { ...tiktokChannel, context: { tiktokShop: status } };
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture(channel),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { state: "shop_enabled", effectiveState: "unknown", stale: true },
    });
  });

  it("returns CHANNEL_NOT_TIKTOK for a non-tiktok_video channel", async () => {
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture({ ...tiktokChannel, kind: "instagram_stories" }),
    );
    expect(result).toEqual({ ok: false, error: "CHANNEL_NOT_TIKTOK" });
  });

  it("returns NOT_FOUND for an unknown channel", async () => {
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "missing" },
      actorId,
      fixture(null),
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("allows a reviewer to read", async () => {
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture(tiktokChannel, "reviewer"),
    );
    expect(result.ok).toBe(true);
  });

  it("denies a non-member", async () => {
    const result = await getTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      fixture(tiktokChannel, "other"),
    );
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});
