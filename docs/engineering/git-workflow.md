# Git Workflow

**Status:** Accepted

## Principles

- `main` is always reviewable and releasable.
- Changes are small, cohesive, and easy to revert.
- History explains intent, not every temporary edit.
- Generated assets, secrets, model weights, and build output never enter Git.

## Normal workflow

1. Sync `main`.
2. Create a focused branch from `main`.
3. Make test-backed, incremental commits.
4. Rebase or update from `main` before review when needed.
5. Open a pull request with evidence of verification.
6. Squash merge when intermediate commits do not add useful history; otherwise preserve meaningful commits.
7. Delete the merged branch.

The repository's initial foundation may be committed directly to an unborn `main`; feature development uses branches afterward.

## Commit format

Use Conventional Commits:

```text
type(optional-scope): imperative summary
```

Allowed common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, and `revert`.

Examples:

```text
docs: establish project architecture and standards
feat(identity): add expiring workspace invitations
fix(publishing): reconcile unknown provider outcome
```

## Commit rules

- Subject is concise, imperative, and has no trailing period.
- Body explains why and tradeoffs when the diff is not self-evident.
- Reference the issue or ADR when relevant.
- Do not commit failing tests, commented-out code, temporary logs, or unrelated formatting.
- Never bypass hooks or CI to make a commit appear green.

## Releases

Use semantic versioning once the first deployable release exists. Until then, changes remain unreleased on `main`. Release notes describe user-visible behavior, migrations, provider changes, and rollback considerations.
