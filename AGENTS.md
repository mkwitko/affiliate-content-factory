# Agent Operating Contract

This file is the entry point for every AI or human contributor. Read it before changing the repository.

## Mission

Build the simplest reliable system that helps selected people generate attributable income through content, offers, services, and digital products.

## Required reading order

1. `README.md`
2. `docs/architecture/system-design.md`
3. `docs/engineering/standards.md`
4. Any ADR governing the area being changed

For creative pipeline work (copy, creatives, Reels, QA), start with
`docs/creative-engine/architecture.md`.

## Non-negotiable rules

- Use English for code, documentation, commits, logs, API fields, and database names.
- Use TypeScript strict mode. Do not introduce `any` without a documented boundary reason.
- Keep the system a modular monolith until measured load or team ownership proves a split is necessary.
- Put business rules in domain/application modules, not routes, UI components, jobs, or provider adapters.
- Validate untrusted input at system boundaries.
- Treat every external provider as replaceable through a small interface.
- Scope every tenant-owned query by `workspaceId`; deny access by default.
- Never commit secrets, tokens, generated media, model weights, or personal data.
- Never publish content, spend money, or send messages without an explicit user-approved policy.
- Never invent product facts, reviews, prices, discounts, earnings, or performance claims.
- Keep changes small. Do not refactor unrelated code.
- Prefer deletion and reuse over new abstractions or dependencies.

## Simplicity test

Before adding a service, package, abstraction, table, dependency, or configuration option, answer:

1. Which current accepted requirement needs it?
2. What is the simpler alternative?
3. Can the decision be postponed safely?
4. How will it be tested and removed?

If the first answer is unclear, do not add it.

## Architecture boundaries

The target repository layout is:

```text
apps/
  api/       HTTP API and MCP transport
  web/       Operator dashboard
  worker/    Background job runner
packages/
  core/      Domain and application use cases
  contracts/ Shared schemas and public types
  providers/ External provider adapters
  config/    Shared build and lint configuration
```

Dependencies point inward:

```text
apps -> providers -> core
apps -> contracts
providers -> contracts
core -> contracts
```

`core` must not import Fastify, React, Prisma, provider SDKs, or environment variables.

## Work procedure

1. Confirm the active roadmap slice and acceptance criteria.
2. Inspect the current code and tests before proposing a change.
3. Write or update a short implementation plan for multi-step work.
4. Use test-driven development for behavior changes.
5. Implement only the current slice.
6. Run focused tests, then the repository quality gate.
7. Review the diff for scope, security, and accidental secrets.
8. Commit one coherent change using Conventional Commits.
9. Update documentation when behavior or an architectural decision changes.

## Definition of done

A change is done only when:

- Acceptance criteria are demonstrably met.
- Automated tests cover success, validation, authorization, and provider failure paths where relevant.
- Formatting, linting, type-checking, tests, and build pass.
- Logs contain context but no secrets or sensitive payloads.
- Database changes are backward-safe or have a rollback path.
- User-facing actions remain understandable and reversible.
- Documentation and ADRs match the implementation.

## Commands

Commands will become authoritative after the workspace is scaffolded. The intended root quality gate is:

```bash
pnpm check
```

It must run formatting verification, linting, type-checking, tests, and build without changing files.

## When requirements are unclear

Do not guess about money movement, legal claims, publishing behavior, account permissions, destructive operations, or licensing. Record the decision needed and ask the owner. For low-risk implementation detail, choose the smallest reversible option and document the assumption.
