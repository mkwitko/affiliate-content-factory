# ADR 0012: Home machines reach production through a task API, never the database

Date: 2026-09-30
Status: accepted (owner chose option 3 on 2026-09-30; closes decision D4)

## Context

Local-AI jobs (`direct_scenes`, `generate_plates`, `review_frames`; v2 slices 26, 27, 29) need a
GPU that only the owner's home machines have (Windows RX 6650 XT, MacBook Air M1). The worker
talks to Neon and R2 directly with the one full database credential. Decision D4 asked how a
home machine may take part without that credential. Options were: (1) no access, files
imported by hand; (2) a restricted Postgres role; (3) a task API with a scoped token. Option 2
still exposes the database to a home network and the jobs table holds every workspace's jobs.

## Decision

1. A home machine never holds database or R2 credentials. The `local_ai` worker profile keeps
   refusing any non-loopback `DATABASE_URL` (development against a local database only).
2. The API exposes three endpoints under `/v1/home-worker/` (claim, result, fail), authenticated
   by a **home worker token**: random, shown once, stored as a SHA-256 hash, bound to one
   workspace and a list of capabilities (`scene_director`, `image_generation`, `visual_qa`),
   revocable, with a last-used time. MCP tools (owner only) create, list and revoke tokens.
3. The **server** claims the job (same queue, same exclusive local-AI set and lease) and sends a
   self-contained **task**: everything the model step needs and nothing else. Files the task
   must read (the rendered MP4 for frame review) travel as short-lived signed download URLs.
4. The home machine runs only the model step and posts the **result**: a director plan, plate
   images (bytes in the request, bounded), or a frame review. The server re-validates every
   result exactly as an in-process job would (schema, copy integrity, catalog, rights, size and
   type) and performs every write. A result can only complete the task it was issued for, with
   its lease token, by a token of the same workspace with the needed capability.
5. Results are untrusted input: a malformed or unsafe result fails the task, never writes.
   Posting a result atomically swaps the lease token, so a replayed post finds nothing. Plates
   are fully decoded and re-encoded before they are stored (512 to 4096 px). Review findings
   are limited to the `vlm_<kind>` ids, notes and severities the in-process review produces.
   Only an `image_generation` token may send a plate-sized body (else 1 MB), one upload per
   token at a time, checked before the body is read.
6. A home claim waits only for its own workspace's local-AI slot, so one workspace's machine
   cannot hold up another's. A shared `local_ai` worker still sees one global slot.
7. Posted images are held, not banked (owner decision, 2026-10-01). The server can sanitize an
   image but cannot prove which model drew it, so the declared model is recorded, never trusted.
   Each plate is stored in the `pending_review` asset state with no commercial rights and with
   its provenance in `metadata.homeWorker`: token id and prefix, job id, capability, declared
   model, worker version (the client's `git describe`), receive time, SHA-256 of the prompt and
   size (input) and of the posted bytes; the asset checksum is the stored output's hash. Held
   plates are never picked or rendered but count toward the pool, so the machine is not asked
   for the same plate again. `review_home_worker_asset` (owner or operator) approves (active,
   commercial rights only for an allowlisted generator) or rejects (archived);
   `list_assets state=pending_review` shows them with preview links. A `trusted_home_worker`
   mode that skips the hold may come later as an explicit per-token setting; none exists.
   Structured results (director plans, frame reviews) are not held: the server re-validates
   them completely.
8. The token never appears on a command line, in a log, an error, telemetry or a later listing.
   The client reads `MONEY_MAKER_HOME_TOKEN` from the environment or from an env file outside
   the repository (default `~/.config/money-maker/home-worker.env`, override
   `MONEY_MAKER_HOME_ENV_FILE`) and refuses a file other users can read. The create tool tells
   the operator to store the token at once and not repeat it in the conversation.

## Consequences

- Compromise of a home machine exposes one revocable token that can only claim local-AI tasks of
  one workspace and submit candidate outputs that the server still validates; it cannot read
  scripts outside its tasks, other workspaces, provider secrets or the database.
- The server does more work per local-AI job (task building, result application); the jobs stay
  idempotent per lease.
- Uploads go through the API instead of signed R2 PUT URLs (simpler; plates are under 10 MB).
  Revisit if result payloads grow.
- No inbound port or tunnel on home machines: they only make outbound HTTPS calls.
- Accepted risk: the plain token passes once through the MCP conversation that created it.
  Revoke and reissue a token whose conversation is shared or kept.
- Home-generated plates need a human review before use; until reviewed, a niche's pool stays
  short and renders fall back as they do with an empty bank.
