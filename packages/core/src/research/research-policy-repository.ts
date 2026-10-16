import type { WorkspaceId } from "@money-maker/contracts";
import type { ResearchPolicy } from "./research-policy.js";

export interface ResearchPolicyRepository {
  create(policy: ResearchPolicy): Promise<ResearchPolicy>;
  findForNiche(input: {
    workspaceId: WorkspaceId;
    nicheId: string;
  }): Promise<ResearchPolicy | null>;
  listForWorkspace(workspaceId: WorkspaceId): Promise<readonly ResearchPolicy[]>;
  update(policy: ResearchPolicy): Promise<ResearchPolicy>;
  /** Worker-only, cross-workspace: candidates for a sweep. Day/week due-ness is checked in core. */
  listActiveDue(now: Date): Promise<readonly ResearchPolicy[]>;
  /**
   * Atomically claims a policy for a run: sets lastRunAt=now only where status is ACTIVE and
   * the policy is still due (lastRunAt is null or older than its frequency's due boundary).
   * Returns true only when exactly one row matched, so a paused/revoked/already-claimed policy
   * (by this run or a concurrent replica) is never run twice.
   */
  claimForRun(id: string, now: Date): Promise<boolean>;
  /**
   * Atomically claims a policy for an autonomy top-up run: sets lastRunAt=now only where status is
   * ACTIVE and lastRunAt is null or older than `minIntervalMs`. Shares lastRunAt with claimForRun,
   * so a top-up run today also satisfies the daily sweep.
   */
  claimForTopUp(id: string, now: Date, minIntervalMs: number): Promise<boolean>;
  /** Records the outcome of a claimed run. Only touches lastError, never status/version, and only
   * while the policy is still ACTIVE (a pause/revoke mid-run wins over this write). */
  recordRunResult(id: string, lastError: string | null): Promise<void>;
}
