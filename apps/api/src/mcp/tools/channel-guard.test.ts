import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { McpDependencies } from "../server.js";
import { createChannelTool } from "./create-channel.js";
import { listChannelsTool } from "./list-channels.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connection: ProviderConnection = {
  id: "conn-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  accountId: "account-1",
  secretReference: "secret://workspace/pfm",
  status: "active",
};
const tiktok: Channel = {
  id: "channel-tiktok",
  workspaceId,
  connectionId: connection.id,
  kind: "tiktok_photo_post",
  label: "TikTok",
  status: "active",
  capabilities: {
    maxAssets: 35,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 4000,
    requiredAssetDimensions: { width: 1080, height: 1920 },
  },
};
const threads: Channel = { ...tiktok, id: "channel-threads", kind: "threads", label: "Threads" };

const dependencies: McpDependencies = {
  authenticate: async () => ({ userId: actorId }),
  invitation: {} as McpDependencies["invitation"],
  workspaces: {
    create: async () => ({ id: workspaceId, name: "Workspace" }),
    findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
    findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
    addMembership: async () => undefined,
  },
  providerConnections: {
    create: async (value) => ({ ok: true as const, connection: value }),
    findAllForWorkspace: async () => [connection],
    findForWorkspace: async () => connection,
    revoke: async () => undefined,
  },
  channelRepository: {
    create: async (channel: Channel) => channel,
    listForWorkspace: async () => [tiktok, threads],
    findForWorkspace: async () => null,
    updateStatus: async () => null,
  },
};

describe("channel kind guard", () => {
  it("creates a TikTok photo channel, published as a TikTok draft", async () => {
    const result = await createChannelTool(
      { workspaceId, connectionId: connection.id, kind: "tiktok_photo_post" },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
  });

  it("still creates a Threads channel", async () => {
    const result = await createChannelTool(
      { workspaceId, connectionId: connection.id, kind: "threads" },
      actorId,
      dependencies,
    );
    expect(result.ok).toBe(true);
  });

  it("flags publishable channels in the list", async () => {
    const result = await listChannelsTool({ workspaceId }, actorId, dependencies);
    if (!result.ok) throw new Error("expected ok");
    const channels = (result.value as { channels: Array<Channel & { publishable: boolean }> })
      .channels;
    expect(channels.map((channel) => [channel.kind, channel.publishable])).toEqual([
      ["tiktok_photo_post", true],
      ["threads", true],
    ]);
  });
});
