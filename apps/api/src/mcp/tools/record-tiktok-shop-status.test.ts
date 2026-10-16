import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { AuditPort } from "@money-maker/core/audit/audit-port";
import type { McpDependencies } from "../server.js";
import { recordTikTokShopStatusTool } from "./record-tiktok-shop-status.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

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
  overrides: Readonly<{
    role?: "owner" | "operator" | "reviewer" | "other";
    channel?: Channel | null;
  }> = {},
) => {
  let stored: Channel =
    overrides.channel === undefined ? tiktokChannel : (overrides.channel ?? tiktokChannel);
  const auditEvents: Array<Record<string, unknown>> = [];
  const audit: AuditPort = {
    record: async (event) => {
      auditEvents.push(event as unknown as Record<string, unknown>);
      return "audit-1";
    },
  };
  const channelRepository: ChannelRepository = {
    create: async (value) => value,
    findForWorkspace: async () => (overrides.channel === null ? null : stored),
    updateStatus: async () => null,
    updateContext: async ({ context }) => {
      stored = { ...stored, context };
      return stored;
    },
  };
  const dependencies: McpDependencies = {
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: workspaces(overrides.role ?? "operator"),
    channelRepository,
    audit,
  };
  return { dependencies, auditEvents, channel: () => stored };
};

describe("record_tiktok_shop_status MCP tool", () => {
  it("records a shop_enabled status and audits state without the note", async () => {
    const { dependencies, auditEvents, channel } = fixture();
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "shop_enabled", note: "Confirmado no app" },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({ ok: true, value: { status: { state: "shop_enabled" } } });
    expect((channel().context as Record<string, unknown>).tiktokShop).toMatchObject({
      state: "shop_enabled",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      action: "channel.tiktok_shop_status_recorded",
      metadata: { state: "shop_enabled" },
    });
    expect(JSON.stringify(auditEvents[0])).not.toContain("Confirmado no app");
  });

  it("saves an ineligible account with a bio link and returns the Mercado Livre strategy", async () => {
    const { dependencies, channel } = fixture();
    const result = await recordTikTokShopStatusTool(
      {
        workspaceId,
        channelId: "channel-1",
        state: "not_eligible",
        reason: "followers",
        bioLinkAvailable: true,
      },
      actorId,
      dependencies,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: { state: "not_eligible", bioLinkAvailable: true },
        strategy: "sell_mercado_livre",
      },
    });
    expect((channel().context as Record<string, unknown>).tiktokShop).toMatchObject({
      bioLinkAvailable: true,
    });
  });

  it("preserves other context keys already on the channel", async () => {
    const { dependencies, channel } = fixture({
      channel: { ...tiktokChannel, context: { role: "vendas" } },
    });
    await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "onboarding" },
      actorId,
      dependencies,
    );
    expect(channel().context).toMatchObject({ role: "vendas" });
  });

  it("requires a reason for not_eligible", async () => {
    const { dependencies } = fixture();
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "not_eligible" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });

  it("rejects a note that looks like a CPF", async () => {
    const { dependencies } = fixture();
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "shop_enabled", note: "CPF 123.456.789-01" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "SHOP_STATUS_NOTE_SENSITIVE" });
  });

  it("returns CHANNEL_NOT_TIKTOK for a non-tiktok_video channel", async () => {
    const { dependencies } = fixture({ channel: { ...tiktokChannel, kind: "instagram_stories" } });
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "shop_enabled" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "CHANNEL_NOT_TIKTOK" });
  });

  it("returns NOT_FOUND for an unknown channel", async () => {
    const { dependencies } = fixture({ channel: null });
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "missing", state: "shop_enabled" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("denies a reviewer (owner/operator only)", async () => {
    const { dependencies } = fixture({ role: "reviewer" });
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "shop_enabled" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("denies a non-member", async () => {
    const { dependencies } = fixture({ role: "other" });
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "shop_enabled" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("rejects invalid arguments", async () => {
    const { dependencies } = fixture();
    const result = await recordTikTokShopStatusTool(
      { workspaceId, channelId: "channel-1", state: "made_up" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "INVALID_ARGUMENTS" });
  });
});
