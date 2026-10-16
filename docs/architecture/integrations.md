# Integration Strategy

**Status:** Accepted

## Provider rule

The application depends on capabilities, not vendors. Each external system implements a narrow port and maps vendor-specific identifiers, errors, and limits at the edge.

Example capability ports:

```ts
interface SocialPublisher {
  publish(input: PublishRequest): Promise<PublishResult>;
  getStatus(externalPublicationId: string): Promise<PublicationStatus>;
}

interface AssetStore {
  createUpload(input: CreateUploadRequest): Promise<UploadTarget>;
  createDownload(input: CreateDownloadRequest): Promise<DownloadTarget>;
  deleteObject(key: string): Promise<void>;
}
```

Ports stay small. Do not create a universal provider abstraction before two implementations prove a shared shape.

## Adoption order

| Capability | Initial choice | Later option | Adoption rule |
|---|---|---|---|
| Social publishing | Post for Me | Metricool or direct APIs | Replace/add when reliability, analytics, or account economics justify it |
| Design refinement | Canva, human-in-the-loop | Additional renderers | Optional; runtime must not depend on an editor session |
| Asset storage | Cloudflare R2 | Another S3-compatible store | Keep object storage behind `AssetStore`; API and MCP receive only short-lived signed targets |
| Database | Neon PostgreSQL | Managed PostgreSQL alternative | Standard PostgreSQL behavior remains portable |
| Digital checkout | One validated marketplace first | Gumroad, Kiwify, Hotmart, Payhip adapters | Add only after a product needs that market |
| AI text | Gateway/provider selected per task | Additional models | Store model, prompt version, latency, and cost |
| Image/video | Cloud first for validation | Local AMD worker or another cloud provider | Choose per job capability, quality, latency, and cost |
| Messaging | Telegram first where appropriate | WhatsApp official API | Respect opt-in and platform rules |

## Credential model

- Platform credentials are owned by the platform and limited to infrastructure capabilities.
- User credentials belong to one workspace and provider connection.
- Store encrypted secret material outside ordinary application fields when possible.
- Persist only a secret reference, provider account metadata, scopes, expiry, and health state.
- Refresh and revoke centrally; never pass raw provider secrets to the browser or model context.

### Post For Me connection lifecycle

Each workspace configures its own Post For Me connection through the authenticated HTTP API or
MCP tools. Owners and operators may create and revoke a connection; reviewers may only inspect
redacted connection metadata. The API key is accepted once, encrypted in the workspace-scoped
secret store, and never returned in HTTP responses, MCP content, logs, prompts, or ordinary
database records.

Use `create_provider_connection` or the equivalent HTTP endpoint to add a key, then use the
redacted list operation to verify the provider and account status. Revoke the old connection
before rotating a key. A duplicate provider/account is reported as a safe conflict, and a failed
connection write removes the staged secret.

One Post For Me connection (API key plus brand handle, e.g. `exampleshop.home`) covers every
social network; the connection stores only the Instagram account id. Instagram and Threads (and
any other platform) have separate Post For Me account ids under the same key, so the Post For Me
adapter (`packages/providers/src/post-for-me/social-publisher.ts`) resolves each non-Instagram
platform's account at publish time by listing that key's accounts for the platform and matching
the connection's handle, falling back to the sole account when there is exactly one. Core stays
unaware of this; it never sees Post For Me account ids beyond `accountId`.

`SECRET_STORE_MASTER_KEY` is a 32-byte base64url deployment secret supplied only to API and worker
processes. Keep it in the deployment secret manager, rotate it through an explicit migration plan
that can decrypt existing records, and never expose it to browser, MCP, provider, or model
contexts. A key rotation without a re-encryption procedure would make existing workspace secrets
unreadable, so rotation is an operational change requiring a backup and rollback plan.

## Provider reliability

Every side-effect adapter must define:

- Idempotency behavior.
- Timeout and retry classification.
- Rate-limit response handling.
- Credential-expired behavior.
- Reconciliation strategy for unknown outcomes.
- Normalized error codes safe to show users.
- Cost or quota capture where available.

## Webhooks

Verify signatures against the raw body, reject stale or replayed events, store the provider event ID, acknowledge duplicates safely, and process business effects asynchronously.

## MCP HTTP subset

The API exposes an authenticated JSON-RPC endpoint at `POST /mcp`. The initial supported protocol version is `2024-11-05`, with only these methods:

- `initialize`, returning the server protocol version and `tools` capability.
- `tools/list`, returning the read-only and side-effecting workspace tool definitions.
- `tools/call`, returning MCP-compatible `content` and `structuredContent` envelopes.

Malformed requests, unknown methods, invalid method parameters, authentication failures, and unexpected failures use numeric JSON-RPC errors. Tool validation and authorization failures are tool results with `isError: true`; they do not become hidden side effects. Authentication is supplied by the trusted API composition through the Fastify request context. Tool arguments and arbitrary headers never provide an actor identity.

## Evaluation checklist

Before adopting a provider, record:

- Capability and known limitations.
- Current pricing and quota.
- Terms relevant to automation and commercial use.
- Data location and retention.
- OAuth scopes or credentials required.
- Export and deletion support.
- Fallback and removal plan.
- Smallest experiment that can validate it.
