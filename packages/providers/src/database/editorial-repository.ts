import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import {
  withClaimKindDefault,
  type ClaimInput,
  type ContentScript,
  type EditorialReview,
} from "@money-maker/core/content/editorial";
import type { EpisodeSpec } from "@money-maker/core/story/story";
import type { EditorialRepository } from "@money-maker/core/content/editorial-repository";
import type { DatabaseClient } from "./client.js";
import type { Prisma } from "../../generated/prisma/client.js";

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const scriptFromRow = (row: {
  id: string;
  workspaceId: string;
  contentItemId: string;
  version: number;
  status: string;
  body: string;
  language: string;
  claims: unknown;
  beats: unknown;
  checksum: string;
  episodePlan?: unknown;
  createdAt: Date;
  actorId: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  approvedChecksum: string | null;
}): ContentScript => ({
  id: row.id,
  workspaceId: parseWorkspaceId(row.workspaceId),
  contentItemId: row.contentItemId,
  version: row.version,
  status: row.status.toLowerCase() as ContentScript["status"],
  body: row.body,
  language: row.language,
  claims: withClaimKindDefault(row.claims as readonly ClaimInput[]),
  beats: row.beats as ContentScript["beats"],
  checksum: row.checksum,
  ...(row.episodePlan ? { episodePlan: row.episodePlan as EpisodeSpec } : {}),
  createdAt: row.createdAt,
  actorId: parseUserId(row.actorId),
  ...(row.approvedBy ? { approvedBy: parseUserId(row.approvedBy) } : {}),
  ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
  ...(row.approvedChecksum ? { approvedChecksum: row.approvedChecksum } : {}),
});
const reviewFromRow = (row: {
  id: string;
  workspaceId: string;
  variantId: string;
  publicationFingerprint: string;
  rightsFingerprint: string;
  reviewPolicyVersion: number;
  checklist: unknown;
  verdict: string;
  notes: string;
  reviewerId: string;
  decidedAt: Date;
}): EditorialReview => ({
  id: row.id,
  workspaceId: parseWorkspaceId(row.workspaceId),
  variantId: row.variantId,
  publicationFingerprint: row.publicationFingerprint,
  reviewPolicyVersion: row.reviewPolicyVersion,
  rightsFingerprint: row.rightsFingerprint,
  checklist: row.checklist as EditorialReview["checklist"],
  verdict: row.verdict.toLowerCase() as EditorialReview["verdict"],
  notes: row.notes,
  reviewerId: parseUserId(row.reviewerId),
  decidedAt: row.decidedAt,
});

export class PrismaEditorialRepository implements EditorialRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async createScript(script: ContentScript): Promise<ContentScript> {
    try {
      const row = await this.client.contentScript.create({
        data: {
          id: script.id,
          workspaceId: script.workspaceId,
          contentItemId: script.contentItemId,
          version: script.version,
          status: "DRAFT",
          body: script.body,
          language: script.language,
          claims: json(script.claims),
          beats: json(script.beats),
          ...(script.episodePlan ? { episodePlan: json(script.episodePlan) } : {}),
          checksum: script.checksum,
          actorId: script.actorId,
          createdAt: script.createdAt,
        },
      });
      return scriptFromRow(row);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002")
        throw new Error("SCRIPT_VERSION_CONFLICT");
      throw error;
    }
  }

  public async findScriptForWorkspace(input: {
    workspaceId: ContentScript["workspaceId"];
    scriptId: string;
  }) {
    const row = await this.client.contentScript.findFirst({
      where: { id: input.scriptId, workspaceId: input.workspaceId },
    });
    return row ? scriptFromRow(row) : null;
  }

  /** Approved scripts of one workspace, read-only (production director benchmark export). */
  public async listApprovedScripts(input: { workspaceId: ContentScript["workspaceId"] }) {
    const rows = await this.client.contentScript.findMany({
      where: { workspaceId: input.workspaceId, status: "APPROVED" },
      orderBy: [{ contentItemId: "asc" }, { version: "desc" }, { id: "asc" }],
    });
    return rows.map(scriptFromRow);
  }

  public async findScriptVersion(input: {
    workspaceId: ContentScript["workspaceId"];
    contentItemId: string;
    version?: number;
  }) {
    const row = await this.client.contentScript.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contentItemId: input.contentItemId,
        ...(input.version ? { version: input.version } : {}),
      },
      orderBy: { version: "desc" },
    });
    return row ? scriptFromRow(row) : null;
  }

  public async nextScriptVersion(input: {
    workspaceId: ContentScript["workspaceId"];
    contentItemId: string;
  }) {
    const row = await this.client.contentScript.aggregate({
      where: { workspaceId: input.workspaceId, contentItemId: input.contentItemId },
      _max: { version: true },
    });
    return (row._max.version ?? 0) + 1;
  }

  public async approveDraft(input: {
    workspaceId: ContentScript["workspaceId"];
    scriptId: string;
    checksum: string;
    actorId: ContentScript["actorId"];
    approvedAt: Date;
  }) {
    const updated = await this.client.contentScript.updateMany({
      where: {
        id: input.scriptId,
        workspaceId: input.workspaceId,
        status: "DRAFT",
        checksum: input.checksum,
      },
      data: {
        status: "APPROVED",
        approvedBy: input.actorId,
        approvedAt: input.approvedAt,
        approvedChecksum: input.checksum,
      },
    });
    return updated.count
      ? this.findScriptForWorkspace({ workspaceId: input.workspaceId, scriptId: input.scriptId })
      : null;
  }

  public async createReview(review: EditorialReview): Promise<EditorialReview> {
    const row = await this.client.contentEditorialReview.create({
      data: {
        id: review.id,
        workspaceId: review.workspaceId,
        variantId: review.variantId,
        publicationFingerprint: review.publicationFingerprint,
        reviewPolicyVersion: review.reviewPolicyVersion,
        rightsFingerprint: review.rightsFingerprint,
        checklist: json(review.checklist),
        verdict: review.verdict.toUpperCase(),
        notes: review.notes,
        reviewerId: review.reviewerId,
        decidedAt: review.decidedAt,
      },
    });
    return reviewFromRow(row);
  }

  public async findCurrentReview(input: {
    workspaceId: EditorialReview["workspaceId"];
    variantId: string;
  }) {
    const row = await this.client.contentEditorialReview.findFirst({
      where: { workspaceId: input.workspaceId, variantId: input.variantId },
      orderBy: [{ decidedAt: "desc" }, { createdAt: "desc" }],
    });
    return row ? reviewFromRow(row) : null;
  }
}
