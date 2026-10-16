# Development Tooling

Last audited: 2026-09-21.

## Repository baseline

- Node.js 24 and pnpm 11.19.0 are installed and match the repository engines.
- TypeScript strict mode, Biome formatting/linting, Vitest, Prisma 7, Fastify 5, React, Vite, TanStack Router/Query, Zod, and PostgreSQL adapters are already in the workspace.
- `pnpm check` is the authoritative local quality gate. `pnpm env:validate` checks only the shape of local PostgreSQL configuration; it never prints secret values or tests connectivity.
- Git workflow and Conventional Commit guidance is in `docs/engineering/git-workflow.md`.

## Available development skills

The current Codex environment already provides the relevant workflow skills; none were duplicated or installed into the repository:

- Superpowers: planning/spec alignment, TDD, systematic debugging, verification before completion, code review, isolated worktrees, parallel delegation, and branch finishing.
- Caveman: focused exploration, safe refactoring, migration planning, review, verification, and Conventional Commit assistance.
- Neon/Postgres: Neon, PostgreSQL, migrations, pooling, and transaction guidance.
- Redis development: available for a future measured need only; Redis is intentionally not part of the current architecture.
- Sentry: read-only observability skill, available if a Sentry project is connected.
- Canva and Creative Production: optional creative workflows, not runtime dependencies.

The repository-approved external skill list and activation rules are maintained in `docs/engineering/skills.md`.

## Quality and CI

Run locally:

```bash
pnpm install --frozen-lockfile
pnpm env:validate
pnpm check
```

GitHub Actions is configured in `.github/workflows/ci.yml`. It runs the same quality gate and deploys Prisma migrations only when `TEST_DATABASE_URL` is configured.

Required CI secrets for database-backed integration tests:

- `DATABASE_URL`
- `DIRECT_URL`
- `TEST_DATABASE_URL`

Integration tests are skipped locally and in CI when `TEST_DATABASE_URL` is absent. Use a disposable PostgreSQL database only; never point it at production.

## Authentication status

No application authentication provider is connected. The API intentionally fails closed until a trusted session/token provider is selected. No credentials were added by this configuration task.
