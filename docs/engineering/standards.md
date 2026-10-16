# Engineering Standards

**Status:** Accepted

## Design

- Prefer functions and focused modules over class hierarchies.
- Use a use case for an intentional business action, not generic CRUD when a state transition matters.
- Keep domain values explicit: `WorkspaceId`, money with currency, content status, and provider result.
- Avoid repository-wide utility drawers. Put code next to the capability that owns it.
- Introduce an abstraction at a real boundary or after duplication proves the common behavior.
- Comments explain why, constraints, or risk; names and tests explain what.

## TypeScript

- Enable strict compiler options, including unchecked indexed access.
- Use `unknown` for untrusted values and parse them at the boundary.
- Prefer discriminated unions for state and result types.
- Do not use non-null assertions to bypass missing-state design.
- Export the smallest public API from each module.
- Avoid TypeScript enums when literal unions or `as const` objects are sufficient.

## API and MCP

- Parse all path, query, body, header, webhook, and MCP arguments.
- Return stable machine-readable error codes and human-readable messages.
- Do not expose stack traces, database errors, or provider payloads.
- Mutation endpoints accept idempotency keys when a retry could duplicate an effect.
- Pagination is bounded and cursor-based for growing collections.
- OpenAPI and MCP schemas derive from authoritative contracts where practical.

## Database

- Use migrations for every schema change; never rely on production schema push.
- Name constraints and indexes deliberately.
- Add indexes from observed access paths, not speculation.
- Transactions protect invariants; external network calls do not run inside database transactions.
- Use an outbox/job record to bridge database state and external side effects.
- Test tenant isolation and uniqueness with realistic PostgreSQL behavior.

## Background jobs

- Jobs contain identifiers, not secret or oversized payloads.
- Handlers are safe to retry.
- Record attempt count, next attempt, terminal reason, and correlation ID.
- Bound retries and use backoff with jitter for transient failures.
- Unknown provider outcomes require reconciliation, not blind repetition.

## Testing

Testing follows risk:

- Unit tests for domain rules, value parsing, state transitions, and cost calculations.
- Integration tests for repositories, transactions, tenant isolation, queues, and adapters at protocol boundaries.
- Contract tests for provider mappings and recorded fixtures with secrets removed.
- End-to-end tests for a small number of money and security critical journeys.

Tests assert public behavior. Mock provider ports, not internal implementation details. Every fixed bug receives a regression test.

## Observability

- Structured JSON logs in deployed processes.
- Correlation IDs across requests, jobs, publications, and webhooks.
- Metrics for job latency, provider success, rate limits, generation cost, publication outcomes, and attribution freshness.
- Audit events are distinct from diagnostic logs.
- Never log access tokens, cookies, prompts containing private data, or complete provider payloads.

## Dependencies

Add a runtime dependency only when it:

1. Replaces meaningful, risky code.
2. Is maintained and license-compatible.
3. Has acceptable supply-chain and bundle impact.
4. Can be wrapped at a boundary if it is vendor-specific.

Pin the package manager version and commit the lockfile.

## UI and accessibility

- Mobile-first, with a usable baseline at 390 px.
- Make the next action and its consequence obvious.
- Show progress for multi-step workflows and actionable recovery for failures.
- Do not encode status using color alone.
- Keyboard access, visible focus, semantic HTML, labels, and reduced-motion support are required.
- Require confirmation that names the external effect before publish, spend, revoke, or destructive actions.

## Quality gate

The root `pnpm check` command will run, in order:

1. Formatting verification.
2. Linting.
3. Type-checking.
4. Unit and integration tests.
5. Production build.

CI and local development use the same commands.
