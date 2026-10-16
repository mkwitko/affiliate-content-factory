import type { WorkspaceId } from "@money-maker/contracts";
import type { AssetRepository } from "../assets/asset-repository.js";
import type { ContentRepository } from "../content/content-repository.js";
import { pendingVariantStates } from "../content/pending.js";
import type { JobStats } from "../jobs/job-stats.js";
import type { NicheRepository } from "../niches/niche-repository.js";
import type { PublicationAttemptRepository } from "../publishing/publication.js";
import type { ProductCandidateRepository } from "../research/product-candidate-repository.js";

export const HUMAN_ACTION_KINDS = [
  "affiliate_link",
  "content_approval",
  "publication_unknown",
  "asset_review",
  "needs_attention",
] as const;
export type HumanActionKind = (typeof HUMAN_ACTION_KINDS)[number];

export type HumanAction = Readonly<{
  /** `kind:refId`, stable while the action stays open. */
  id: string;
  kind: HumanActionKind;
  title: string;
  /** Short pt-BR instruction for the operator. */
  instructions: string;
  refs: Readonly<{
    candidateId?: string;
    listingUrl?: string;
    affiliateLinkBuilderUrl?: string;
    variantId?: string;
    attemptId?: string;
    assetId?: string;
    jobId?: string;
  }>;
  nicheName?: string;
  createdAt: Date;
}>;

export type HumanActionDeps = Readonly<{
  niches: Pick<NicheRepository, "listForWorkspace">;
  candidates: Pick<ProductCandidateRepository, "listByState">;
  content: Pick<ContentRepository, "listVariantsForWorkspace" | "findContentItemForWorkspace">;
  attempts: Pick<PublicationAttemptRepository, "listLatestForVariants">;
  assets: Pick<AssetRepository, "listForWorkspace">;
  jobStats?: Pick<JobStats, "listFailed">;
  affiliateLinkBuilderUrl: string;
}>;

export const NEEDS_ATTENTION_WINDOW_MS = 7 * 24 * 3_600_000;

/** Everything waiting on a person, affiliate links first. Read-only; actions vanish once resolved. */
export const listHumanActions = async (
  deps: HumanActionDeps,
  input: Readonly<{ workspaceId: WorkspaceId; limit: number; now?: Date }>,
): Promise<readonly HumanAction[]> => {
  const { workspaceId, limit } = input;
  const now = input.now ?? new Date();
  const nicheNames = new Map(
    ((await deps.niches.listForWorkspace?.(workspaceId)) ?? []).map((niche) => [
      niche.id,
      niche.name,
    ]),
  );
  const actions: HumanAction[] = [];

  for (const row of await deps.candidates.listByState({
    workspaceId,
    states: ["awaiting_affiliate_link"],
    take: limit,
  })) {
    const nicheName = nicheNames.get(row.nicheId);
    actions.push({
      id: `affiliate_link:${row.id}`,
      kind: "affiliate_link",
      title: row.title,
      instructions:
        "Abra o anúncio, gere o link de afiliado no construtor do Mercado Livre e envie com submit_affiliate_links.",
      refs: {
        candidateId: row.id,
        listingUrl: row.listingUrl,
        affiliateLinkBuilderUrl: deps.affiliateLinkBuilderUrl,
      },
      ...(nicheName ? { nicheName } : {}),
      createdAt: row.qualifiedAt ?? row.discoveredAt,
    });
  }

  const variants = await deps.content.listVariantsForWorkspace(workspaceId, {
    states: pendingVariantStates,
    limit: 50,
  });
  const attempts = await deps.attempts.listLatestForVariants({
    workspaceId,
    variantIds: variants.map((variant) => variant.id),
  });
  for (const variant of variants.filter((entry) => entry.state === "ready_for_review")) {
    const item = await deps.content.findContentItemForWorkspace({
      workspaceId,
      contentItemId: variant.contentItemId,
    });
    const nicheName = item ? nicheNames.get(item.nicheId) : undefined;
    actions.push({
      id: `content_approval:${variant.id}`,
      kind: "content_approval",
      title: item?.title ?? "Conteúdo para aprovar",
      instructions: "Revise a prévia e aprove (approve_content) ou rejeite (reject_content).",
      refs: { variantId: variant.id },
      ...(nicheName ? { nicheName } : {}),
      createdAt: now,
    });
  }
  for (const variant of variants) {
    const attempt = attempts.get(variant.id);
    if (attempt?.status !== "unknown_outcome") continue;
    actions.push({
      id: `publication_unknown:${attempt.attemptId}`,
      kind: "publication_unknown",
      title: "Resultado da publicação desconhecido",
      instructions:
        "Confira na plataforma se o post saiu e registre o resultado com reconcile_publication.",
      refs: { variantId: variant.id, attemptId: attempt.attemptId },
      createdAt: attempt.updatedAt,
    });
  }

  for (const asset of (await deps.assets.listForWorkspace?.(workspaceId, "pending_review")) ?? [])
    actions.push({
      id: `asset_review:${asset.id}`,
      kind: "asset_review",
      title: "Imagem gerada para revisar",
      instructions: "Veja a prévia (list_assets) e decida com review_home_worker_asset.",
      refs: { assetId: asset.id },
      createdAt: now,
    });

  for (const job of (await deps.jobStats?.listFailed({
    workspaceId,
    since: new Date(now.getTime() - NEEDS_ATTENTION_WINDOW_MS),
    take: 20,
  })) ?? [])
    actions.push({
      id: `needs_attention:${job.id}`,
      kind: "needs_attention",
      title: `Tarefa falhou: ${job.name}`,
      instructions: `Falha definitiva (${job.terminalReason ?? "motivo desconhecido"}). Avise o operador; não tente de novo automaticamente.`,
      refs: { jobId: job.id },
      createdAt: job.updatedAt,
    });

  return actions.slice(0, limit);
};
