import type { WorkspaceId } from "@money-maker/contracts";
import type { Channel } from "./channel.js";

export interface ChannelRepository {
  create(channel: Channel): Promise<Channel>;
  listForWorkspace?(workspaceId: WorkspaceId): Promise<readonly Channel[]>;
  findForWorkspace(input: { workspaceId: WorkspaceId; channelId: string }): Promise<Channel | null>;
  updateStatus(input: {
    workspaceId: WorkspaceId;
    channelId: string;
    status: Channel["status"];
  }): Promise<Channel | null>;
  updateContext?(input: {
    workspaceId: WorkspaceId;
    channelId: string;
    context: Record<string, unknown>;
  }): Promise<Channel | null>;
  /** Binds the channel to a niche profile (null unbinds). The niche must be the workspace's. */
  setNiche?(input: {
    workspaceId: WorkspaceId;
    channelId: string;
    nicheId: string | null;
  }): Promise<Channel | null>;
}
