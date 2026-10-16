# Security Policy

## Reporting

Do not disclose vulnerabilities in public issues. Report them privately to the repository owner through an agreed private channel. Include impact, reproduction steps, affected versions, and a suggested mitigation when possible.

## Security baseline

- Invite-only access with revocable membership.
- Server-enforced workspace isolation.
- Least-privilege provider scopes.
- Encrypted credentials at rest and redacted logs.
- Short-lived sessions with rotation and revocation.
- Rate limits on authentication, publishing, generation, and webhook endpoints.
- Signature verification and replay protection for webhooks.
- Idempotency keys for external side effects.
- Human approval gates for publishing and spending by default.
- Audit events for security-sensitive and revenue-affecting actions.

## Secret handling

Secrets belong in an approved secret manager or deployment environment. Local development uses ignored `.env` files created from `.env.example`. Never place real credentials in fixtures, screenshots, prompts, logs, issues, or documentation.

## AI and media safety

- Require documented consent for face, voice, or identity cloning.
- Preserve the source and license of media used commercially.
- Disclose synthetic or sponsored content when law or platform policy requires it.
- Block deceptive impersonation, fabricated testimonials, and invented product evidence.
- Keep original evidence separate from generated claims.

Supported versions will be listed after the first release.
