# Contributing

Money Maker currently accepts changes coordinated by the repository owner.

## Before starting

- Read `AGENTS.md` and the relevant product and architecture documents.
- Open or reference a focused issue with acceptance criteria.
- Keep one concern per branch and pull request.
- Do not add a dependency without explaining why existing code or platform APIs are insufficient.

## Branches and commits

Use short kebab-case branches:

- `feat/invite-only-onboarding`
- `fix/workspace-token-scope`
- `docs/provider-contracts`

Use Conventional Commits:

- `feat: add workspace invitations`
- `fix: prevent cross-workspace asset access`
- `docs: define publishing safety policy`
- `test: cover expired provider credentials`
- `chore: configure workspace tooling`

Commits must be coherent, reviewable, and pass the relevant checks. Do not mix formatting sweeps with behavior changes.

## Pull requests

Every pull request must state:

- The problem and why it matters now.
- The smallest solution chosen.
- User-visible behavior.
- Security, data, cost, and provider implications.
- How it was tested.
- Screenshots for visible UI changes.
- Rollback or disable path for risky changes.

## Review checklist

- Is the change inside the accepted roadmap slice?
- Can any code or abstraction be removed?
- Are tenant boundaries enforced server-side?
- Are inputs validated and outputs safe to log?
- Are provider errors mapped to domain-safe errors?
- Are side effects idempotent?
- Are tests behavior-focused rather than implementation-focused?
