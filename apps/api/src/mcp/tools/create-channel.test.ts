import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import type { ProviderConnection } from "@money-maker/core/providers/provider-connection";
import type { McpDependencies } from "../server.js";
import { createChannelTool } from "./create-channel.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const connection: ProviderConnection = {
  id: "connection-1",
  workspaceId,
  provider: "post_for_me",
  mode: "api_key",
  secretReference: "secret://workspace/connection-1",
  accountId: "account-1",
  status: "active",
};

const dependencies = (): McpDependencies =>
  ({
    authenticate: async () => ({ userId: actorId }),
    invitation: {} as McpDependencies["invitation"],
    workspaces: {
      findMembership: async () => ({
        workspaceId,
        userId: actorId,
        role: "owner",
        status: "active",
      }),
    },
    channelRepository: {
      create: async (value: Channel) => value,
      findForWorkspace: async () => null,
      updateStatus: async () => null,
    },
    providerConnections: {
      findForWorkspace: async () => connection,
    },
  }) as unknown as McpDependencies;

describe("create_channel MCP tool", () => {
  it("creates a tiktok_video channel on a Post For Me connection", async () => {
    const result = await createChannelTool(
      { workspaceId, connectionId: connection.id, kind: "tiktok_video" },
      actorId,
      dependencies(),
    );
    expect(result).toMatchObject({ ok: true, value: { channel: { kind: "tiktok_video" } } });
  });
});
