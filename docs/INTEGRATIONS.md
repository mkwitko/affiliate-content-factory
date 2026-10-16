# Integrations

Last audited: 2026-09-21. This document records capability and authentication status; it does not claim that any provider is connected.

## Current architecture

PostgreSQL/Neon is the source of truth, Prisma is the data boundary, and PostgreSQL-backed jobs are the queue. Cloudflare R2 is the planned object-storage provider behind a provider port. Redis is deferred until measured queue or connection pressure requires it. Provider interfaces belong outside `packages/core` and must remain workspace-scoped, auditable, idempotent, and approval-aware.

## Revenue-loop provider readiness

| Capability | Repository status | Authentication required |
|---|---|---|
| Mercado Livre affiliate/product data | Not implemented; provider port is future work | Mercado Livre affiliate/API credentials and approved account |
| Post For Me publishing | Not implemented; publishing adapter is future work | Post For Me account/API credentials and publication policy |
| Cloudflare R2/S3-compatible storage | Implemented as global infrastructure behind the AssetStore port; deployment configuration is still required | R2 account ID, access key ID, secret access key, bucket, and endpoint derived from the account ID |
| Tracked redirects | Not implemented; requires attribution use case and redirect domain | Domain/hosting plus analytics or attribution configuration |
| Storefronts | Not selected; keep provider-specific adapters optional | Credentials for the selected storefront |
| Commission and attribution tracking | Domain concept is planned; no external provider connected | Provider-specific reporting/API credentials where required |

No credentials, tokens, `.env` files, generated media, or private configuration were added.

## Optional integrations detected

- Canva connector is available and requires the user to connect Canva. It is not an application dependency.
- GitHub connector is available for repository/CI workflows.
- Neon connector and native Neon/Postgres skills are available; no Neon project is connected in this audit.
- Sentry skill is available, but `SENTRY_AUTH_TOKEN` is not present and no Sentry project was configured.
- Redis skills are available, but no Redis connection is configured and Redis is deliberately deferred by ADR 0002.
- Creative Production MCP is available locally for future media work; it is not needed for this foundation task.
- No evidence of connected Gumroad, Shopee, Amazon Associates, multilingual-content, local-video, cloud-GPU/video, email, Slack, Discord, or analytics credentials was found.

## MCP servers and usable tools

No project-local MCP server configuration exists in this repository or the Codex project configuration. The configured MCP resource inventory exposes `codex_apps` connectors and the local `creative_production_mcp` server. Read-only repository inspection, local Git, Node, pnpm, TypeScript, Biome, Vitest, and Prisma generation/validation are usable without additional provider authentication. External connectors remain unavailable until their accounts are connected.

## Required next actions

1. Create a disposable PostgreSQL/Neon test database and add `DATABASE_URL`, `DIRECT_URL`, and `TEST_DATABASE_URL` to the supported local/CI secret store.
2. Select and connect the authentication provider before enabling any invitation or workspace mutation in a deployed environment.
3. Configure R2 globally with `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET`; keep the values in the deployment secret manager and never expose them to workspaces or browsers.
4. When the first revenue loop is approved, connect Mercado Livre and Post For Me one at a time through narrow workspace-scoped provider adapters; add credentials only to the secret manager.
4. Add Sentry only when a project and deployment need read-only incident visibility.
