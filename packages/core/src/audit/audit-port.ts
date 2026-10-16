import type { UserId, WorkspaceId } from "@money-maker/contracts";

export type AuditAction =
  | "workspace.invitation.created"
  | "workspace.invitation.accepted"
  | "offer.created"
  | "offer.evidence.added"
  | "offer.activated"
  | "offer.rejected"
  | "content.submitted_for_review"
  | "content.approved"
  | "content.rejected"
  | "content.approval_invalidated"
  | "content.cancelled"
  | "content.script.created"
  | "story.continuity.recorded"
  | "episode.idea.created"
  | "episode.idea.packaged"
  | "episode.idea.decided"
  | "content.script.approved"
  | "content.editorial_review.recorded"
  | "content.storyboard.created"
  | "content.storyboard.scenes_requested"
  | "asset.rights.set"
  | "publication.policy_changed"
  | "research.snapshot.imported"
  | "channel.tiktok_shop_status_recorded"
  | "home_worker.token.created"
  | "home_worker.token.revoked"
  | "home_worker.asset.reviewed"
  | "cloud_provider.connected"
  | "generation_budget.updated"
  | "generation_route.updated"
  | "niche.state_changed"
  | "channel.niche_set"
  | "ai.decision.shadow_recorded"
  | "ai.decision.hook_picked"
  | "job.retried";

/**
 * Exactly one of `actorUserId` (a human, membership-checked action) or `systemActor` (an
 * automated process with no user session, e.g. `"system:offer-refresh"`) identifies who acted.
 */
export type AuditEvent = Readonly<{
  action: AuditAction;
  workspaceId: WorkspaceId;
  actorUserId?: UserId;
  systemActor?: string;
  invitationId?: string;
  targetType?: string;
  targetId?: string;
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}>;

export interface AuditPort {
  record(event: AuditEvent): Promise<string>;
}
