# ADR 0003: External Providers Behind Narrow Ports

- **Status:** Accepted
- **Date:** 2026-09-20

## Context

Social, commerce, storage, and AI providers change pricing, limits, APIs, and policies. Binding business rules to one SDK makes replacement expensive and spreads vendor error shapes throughout the product.

## Decision

Define small capability interfaces in the application boundary and implement provider-specific adapters outside the core. Normalize results and errors. Preserve provider identifiers only where reconciliation requires them.

Do not build a universal abstraction in advance. Each port represents one real application capability and grows only from proven provider differences.

## Consequences

- Use cases are testable without vendor calls.
- Provider replacement and fallback are contained.
- Adapter code performs explicit mapping and may repeat small amounts of vendor-specific logic.
- Lowest-common-denominator interfaces must be avoided; provider-specific capabilities may use separate ports.
