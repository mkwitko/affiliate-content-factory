import { parseWorkspaceId } from "@money-maker/contracts";
import type { Niche } from "@money-maker/core/niches/niche";
import type { NicheRepository } from "@money-maker/core/niches/niche-repository";
import type { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

const toDomain = (record: {
  id: string;
  workspaceId: string;
  name: string;
  audience: string;
  problem: string;
  editorialVoice: string;
  languages: string[];
  monetizationHypothesis: string;
  state: "DRAFT" | "ACTIVE" | "ARCHIVED";
  kind: "AFFILIATE" | "MEDIA";
  context?: unknown;
  slug?: string | null;
}): Niche =>
  Object.freeze({
    id: record.id,
    workspaceId: parseWorkspaceId(record.workspaceId),
    name: record.name,
    audience: record.audience,
    problem: record.problem,
    editorialVoice: record.editorialVoice,
    languages: Object.freeze([...record.languages]),
    monetizationHypothesis: record.monetizationHypothesis,
    state: record.state.toLowerCase() as Niche["state"],
    kind: record.kind.toLowerCase() as Niche["kind"],
    ...(record.context ? { context: record.context as Record<string, unknown> } : {}),
    ...(record.slug ? { slug: record.slug } : {}),
  });

export class PrismaNicheRepository implements NicheRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listForWorkspace(workspaceId: Niche["workspaceId"]): Promise<readonly Niche[]> {
    const records = await this.client.niche.findMany({
      where: { workspaceId },
      orderBy: { name: "asc" },
    });
    return records.map(toDomain);
  }

  public async create(niche: Niche): Promise<Niche> {
    const record = await this.client.niche.create({
      data: {
        id: niche.id,
        workspaceId: niche.workspaceId,
        name: niche.name,
        audience: niche.audience,
        problem: niche.problem,
        editorialVoice: niche.editorialVoice,
        languages: [...niche.languages],
        monetizationHypothesis: niche.monetizationHypothesis,
        state: niche.state.toUpperCase() as "DRAFT" | "ACTIVE" | "ARCHIVED",
        kind: niche.kind.toUpperCase() as "AFFILIATE" | "MEDIA",
        slug: niche.slug ?? null,
      },
    });
    return toDomain(record);
  }

  public async findForWorkspace(input: {
    workspaceId: Niche["workspaceId"];
    nicheId: string;
  }): Promise<Niche | null> {
    const record = await this.client.niche.findFirst({
      where: { id: input.nicheId, workspaceId: input.workspaceId },
    });
    return record ? toDomain(record) : null;
  }

  public async updateState(input: {
    workspaceId: Niche["workspaceId"];
    nicheId: string;
    state: Niche["state"];
  }): Promise<Niche | null> {
    const updated = await this.client.niche.updateMany({
      where: { id: input.nicheId, workspaceId: input.workspaceId },
      data: { state: input.state.toUpperCase() as "DRAFT" | "ACTIVE" | "ARCHIVED" },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, nicheId: input.nicheId });
  }

  public async update(input: {
    workspaceId: Niche["workspaceId"];
    nicheId: string;
    name?: string;
    audience?: string;
    problem?: string;
    editorialVoice?: string;
    languages?: readonly string[];
    monetizationHypothesis?: string;
  }): Promise<Niche | null> {
    const updated = await this.client.niche.updateMany({
      where: { id: input.nicheId, workspaceId: input.workspaceId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.audience !== undefined ? { audience: input.audience } : {}),
        ...(input.problem !== undefined ? { problem: input.problem } : {}),
        ...(input.editorialVoice !== undefined ? { editorialVoice: input.editorialVoice } : {}),
        ...(input.languages !== undefined ? { languages: [...input.languages] } : {}),
        ...(input.monetizationHypothesis !== undefined
          ? { monetizationHypothesis: input.monetizationHypothesis }
          : {}),
      },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, nicheId: input.nicheId });
  }

  public async updateContext(input: {
    workspaceId: Niche["workspaceId"];
    nicheId: string;
    context: Record<string, unknown>;
  }): Promise<Niche | null> {
    const updated = await this.client.niche.updateMany({
      where: { id: input.nicheId, workspaceId: input.workspaceId },
      data: { context: input.context as Prisma.InputJsonValue },
    });
    return updated.count === 0
      ? null
      : this.findForWorkspace({ workspaceId: input.workspaceId, nicheId: input.nicheId });
  }
}
