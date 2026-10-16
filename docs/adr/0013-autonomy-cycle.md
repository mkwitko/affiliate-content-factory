# ADR 0013: A bounded autonomy cycle keeps the factory fed

Date: 2026-10-02
Status: accepted

## Context

The affiliate factory needs a steady supply of qualified products waiting for a human-made
affiliate link, and a way to move linked products into production without an operator
remembering each step. Approval, publication and spend must stay with people and policies.

## Decision

1. `runAutonomyCycle` (core) is one bounded, idempotent pass per workspace: expire `awaiting`
   candidates older than 14 days; release `linked` claims without an offer after 15 minutes; top
   up each active affiliate niche with an active research policy to its `targetPendingLinks`
   (fresh `discovered` rows first, otherwise one discovery run per niche per 6 hours); qualify
   with at most 10 provider reads per niche per cycle; re-enqueue the idempotent package job for
   linked candidates whose offer is active; mark `in_production` candidates `consumed` once their
   item has a variant ready for review or later.
2. The cycle never approves, publishes, creates affiliate links or spends money. Each step and
   niche is isolated; failures become error codes in the counters.
3. Top-up discovery claims the policy with `claimForTopUp`, which shares `lastRunAt` with the
   daily sweep, so the two never double-run. An open-product unique violation during
   qualification marks the candidate `duplicate`.
4. Two callers: the worker loop (every 15 minutes, full profile only, on by default;
   `AUTONOMY_ENABLED=false` stops it, decided by the owner on 2026-10-15) and the MCP tool
   `run_autonomy_cycle`. Money Maker works without any agent.
5. `get_autonomy_status` and `list_human_actions` are read-only views over existing state (jobs
   through the optional `JobStats` port, candidates, variants, publication attempts, assets, home
   worker heartbeats). Failed jobs appear as `needs_attention`; they are never retried by the
   cycle.

## Consequences

- No new tables or migrations. `packageJobsEnqueued` counts idempotent enqueue requests, so a
  pending package job is requested again (harmlessly) each cycle until it runs.
- Discovery spends provider reads only for niches below target.
- Removing the feature means deleting `core/autonomy`, three MCP tools and one worker loop.
