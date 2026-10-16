import { parseWorkspaceId } from "@money-maker/contracts";
import { type Channel, channelCapabilities } from "@money-maker/core/channels/channel";
import type { ChannelRepository } from "@money-maker/core/channels/channel-repository";
import type { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type ChannelKindRecord =
  | "INSTAGRAM_CAROUSEL"
  | "INSTAGRAM_STORIES"
  | "INSTAGRAM_REELS"
  | "THREADS"
  | "TIKTOK_PHOTO_POST"
  | "YOUTUBE"
  | "TIKTOK_VIDEO";

const channelKindToDatabase = (kind: Channel["kind"]): ChannelKindRecord =>
  kind.toUpperCase() as ChannelKindRecord;

const channelKindToDomain = (kind: ChannelKindRecord): Channel["kind"] =>
  kind.toLowerCase() as Channel["kind"];

const toDomain = (record: {
  id: string;
  workspaceId: string;
  connectionId: string;
  nicheId?: string | null;
  kind: ChannelKindRecord;
  label: string;
  status: "ACTIVE" | "INACTIVE";
  capabilities: unknown;
  context?: unknown;
}): Channel =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    connectionId: record.connectionId,
    nicheId: record.nicheId ?? null,
    kind: channelKindToDomain(record.kind),
    label: record.label,
    status: record.status.toLowerCase() as Channel["status"],
    // Capabilities follow the code, so a rule change also applies to channels created earlier.
    capabilities: channelCapabilities[channelKindToDomain(record.kind)],
    ...(record.context ? { context: record.context as Record<string, unknown> } : {}),
  });

export class PrismaChannelRepository implements ChannelRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listForWorkspace(workspaceId: Channel["workspaceId"]): Promise<readonly Channel[]> {
    const records = await this.client.channel.findMany({
      where: { workspaceId, status: "ACTIVE", connection: { status: "ACTIVE" } },
      orderBy: { label: "asc" },
    });
    return records.map(toDomain);
  }

  public async create(channel: Channel): Promise<Channel> {
    const record = await this.client.channel.create({
      data: {
        id: channel.id,
        workspaceId: channel.workspaceId,
        connectionId: channel.connectionId,
        kind: channelKindToDatabase(channel.kind),
        label: channel.label,
        status: channel.status.toUpperCase() as "ACTIVE" | "INACTIVE",
        capabilities: channel.capabilities,
      },
    });
    return toDomain(record);
  }

  public async findForWorkspace(input: {
    workspaceId: Channel["workspaceId"];
    channelId: string;
  }): Promise<Channel | null> {
    const record = await this.client.channel.findFirst({
      where: { id: input.channelId, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record) : null;
  }

  public async updateStatus(input: {
    workspaceId: Channel["workspaceId"];
    channelId: string;
    status: Channel["status"];
  }): Promise<Channel | null> {
    const updated = await this.client.channel.updateMany({
      where: { id: input.channelId, workspaceId: input.workspaceId },
      data: { status: input.status.toUpperCase() as "ACTIVE" | "INACTIVE" },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, channelId: input.channelId });
  }

  public async updateContext(input: {
    workspaceId: Channel["workspaceId"];
    channelId: string;
    context: Record<string, unknown>;
  }): Promise<Channel | null> {
    const updated = await this.client.channel.updateMany({
      where: { id: input.channelId, workspaceId: input.workspaceId },
      data: { context: input.context as Prisma.InputJsonValue },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, channelId: input.channelId });
  }

  public async setNiche(input: {
    workspaceId: Channel["workspaceId"];
    channelId: string;
    nicheId: string | null;
  }): Promise<Channel | null> {
    const updated = await this.client.channel.updateMany({
      where: { id: input.channelId, workspaceId: input.workspaceId },
      data: { nicheId: input.nicheId },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, channelId: input.channelId });
  }
}
