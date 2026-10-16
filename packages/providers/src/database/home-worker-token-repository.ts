import { parseWorkspaceId } from "@money-maker/contracts";
import {
  HOME_CAPABILITIES,
  type HomeCapability,
  type HomeWorkerHeartbeat,
  type HomeWorkerToken,
  type HomeWorkerTokenRepository,
} from "@money-maker/core/home-worker/tokens";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type Row = {
  id: string;
  workspaceId: string;
  name: string;
  tokenHash: string;
  prefix: string;
  capabilities: string[];
  createdById: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  heartbeat: unknown;
  heartbeatAt: Date | null;
};

const fromRow = (row: Row): HomeWorkerToken => ({
  ...row,
  heartbeat: (row.heartbeat as HomeWorkerHeartbeat | null) ?? null,
  workspaceId: parseWorkspaceId(row.workspaceId),
  capabilities: row.capabilities.filter((c): c is HomeCapability =>
    (HOME_CAPABILITIES as readonly string[]).includes(c),
  ),
});

/** Home worker tokens (ADR 0012); every query by hash or scoped by workspace. */
export class PrismaHomeWorkerTokenRepository implements HomeWorkerTokenRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async create(token: HomeWorkerToken): Promise<HomeWorkerToken> {
    return fromRow(
      await this.client.homeWorkerToken.create({
        data: {
          ...token,
          capabilities: [...token.capabilities],
          heartbeat: token.heartbeat ?? Prisma.DbNull,
        },
      }),
    );
  }

  public async findByHash(tokenHash: string): Promise<HomeWorkerToken | null> {
    const row = await this.client.homeWorkerToken.findUnique({ where: { tokenHash } });
    return row ? fromRow(row) : null;
  }

  public async listForWorkspace(workspaceId: string): Promise<readonly HomeWorkerToken[]> {
    const rows = await this.client.homeWorkerToken.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map(fromRow);
  }

  public async revoke(input: { workspaceId: string; id: string; at: Date }) {
    const updated = await this.client.homeWorkerToken.updateMany({
      where: { id: input.id, workspaceId: input.workspaceId, revokedAt: null },
      data: { revokedAt: input.at },
    });
    if (updated.count === 0) return null;
    const row = await this.client.homeWorkerToken.findFirst({
      where: { id: input.id, workspaceId: input.workspaceId },
    });
    return row ? fromRow(row) : null;
  }

  public async touch(input: { id: string; at: Date }): Promise<void> {
    await this.client.homeWorkerToken.updateMany({
      where: { id: input.id, revokedAt: null },
      data: { lastUsedAt: input.at },
    });
  }

  public async recordHeartbeat(input: {
    id: string;
    at: Date;
    heartbeat: HomeWorkerHeartbeat;
  }): Promise<void> {
    await this.client.homeWorkerToken.updateMany({
      where: { id: input.id, revokedAt: null },
      data: { heartbeat: input.heartbeat as Prisma.InputJsonValue, heartbeatAt: input.at },
    });
  }
}
