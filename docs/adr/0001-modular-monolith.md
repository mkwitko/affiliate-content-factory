# ADR 0001: Start as a Modular Monolith

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

The product spans identity, content, publishing, monetization, analytics, and provider integrations, but begins with one small team and one validated revenue loop. Independent services would add deployment, networking, data consistency, and observability costs before those boundaries are proven.

## Decision

Use one TypeScript repository and one cohesive application core. Deploy the web UI, API/MCP host, and worker as separate processes while sharing domain and application modules.

Modules own their behavior and data access. Cross-module behavior goes through application interfaces rather than direct table access.

## Consequences

- Transactions and local development remain simple.
- Module boundaries still support later extraction.
- One deployment may contain code unused by that process.
- Discipline and tests must prevent modules from becoming a coupled codebase.

## Revisit when

A module needs materially different scaling, security isolation, release cadence, runtime, or team ownership and the modular boundary has already proven stable.
