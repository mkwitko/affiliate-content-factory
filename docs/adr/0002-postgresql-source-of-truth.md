# ADR 0002: PostgreSQL as Source of Truth and Initial Queue

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Money Maker needs durable state, tenant isolation, state transitions, auditability, attribution, and background work. Adding Redis and a separate queue at the start increases operational cost and creates cross-system consistency problems.

## Decision

Use PostgreSQL on Neon as the authoritative store. Begin with a PostgreSQL-backed job/outbox mechanism for background work. Keep the queue interface internal so its implementation can change without changing use cases.

Object bytes belong in Cloudflare R2; PostgreSQL stores their metadata, ownership, provenance, and keys.

## Consequences

- Business state and job creation can commit atomically.
- The initial platform has fewer moving parts.
- Workers must claim jobs with safe locking and bounded polling.
- High-throughput or latency-sensitive workloads may later justify Redis or another queue.

## Revisit when

Measured queue delay, connection pressure, throughput, scheduling requirements, or operational isolation cannot be met safely with PostgreSQL.
