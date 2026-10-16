import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { WorkspaceRepository } from "@money-maker/core/workspaces/workspace-repository";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { McpDependencies } from "../server.js";
import { getChannelContextTool } from "./get-channel-context.js";
import { updateChannelContextTool } from "./update-channel-context.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const workspaces: WorkspaceRepository = {
  create: async () => ({ id: workspaceId, name: "Workspace" }),
  findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
  findMembership: async () => ({ workspaceId, userId: actorId, role: "owner", status: "active" }),
  addMembership: async () => undefined,
};

const baseChannel: Channel = {
  id: "channel-1",
  workspaceId,
  connectionId: "connection-1",
  kind: "instagram_carousel",
  label: "Instagram principal",
  status: "active",
  capabilities: {
    maxAssets: 10,
    requiresOrderedAssets: true,
    allowedMimeTypes: ["image/jpeg"],
    captionMaxLength: 2200,
  },
};

describe("channel context MCP tools", () => {
  it("returns NOT_FOUND for an unknown channel", async () => {
    const channelRepository: ChannelRepository = {
      create: async (value) => value,
      findForWorkspace: async () => null,
      updateStatus: async () => null,
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      channelRepository,
    };

    const result = await getChannelContextTool(
      { workspaceId, channelId: "missing" },
      actorId,
      dependencies,
    );
    expect(result).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("stores and reads back a bounded channel context", async () => {
    let stored = baseChannel;
    const channelRepository: ChannelRepository = {
      create: async (value) => value,
      findForWorkspace: async () => stored,
      updateStatus: async () => null,
      updateContext: async ({ context }) => {
        stored = { ...stored, context };
        return stored;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      channelRepository,
    };

    const updated = await updateChannelContextTool(
      {
        workspaceId,
        channelId: "channel-1",
        context: { role: "topo de funil", slideCount: { min: 3, max: 8 } },
      },
      actorId,
      dependencies,
    );
    expect(updated).toMatchObject({
      ok: true,
      value: { channel: { context: { role: "topo de funil" } } },
    });

    const read = await getChannelContextTool(
      { workspaceId, channelId: "channel-1" },
      actorId,
      dependencies,
    );
    expect(read).toMatchObject({ ok: true, value: { context: { role: "topo de funil" } } });
  });

  it("preserves an existing tiktokShop key across an editorial context replace", async () => {
    const tiktokShop = {
      version: 1,
      state: "shop_enabled",
      observedAt: "2026-09-28T12:00:00.000Z",
      source: "operator_confirmation",
    };
    let stored: Channel = { ...baseChannel, context: { role: "antigo", tiktokShop } };
    const channelRepository: ChannelRepository = {
      create: async (value) => value,
      findForWorkspace: async () => stored,
      updateStatus: async () => null,
      updateContext: async ({ context }) => {
        stored = { ...stored, context };
        return stored;
      },
    };
    const dependencies: McpDependencies = {
      authenticate: async () => ({ userId: actorId }),
      invitation: {} as McpDependencies["invitation"],
      workspaces,
      channelRepository,
    };

    const updated = await updateChannelContextTool(
      { workspaceId, channelId: "channel-1", context: { role: "novo" } },
      actorId,
      dependencies,
    );
    expect(updated).toMatchObject({
      ok: true,
      value: { channel: { context: { role: "novo", tiktokShop } } },
    });
  });
});
