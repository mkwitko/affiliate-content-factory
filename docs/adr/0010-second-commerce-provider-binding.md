# ADR 0010: Second commerce provider binding (TikTok Shop)

**Status:** Accepted by owner on 2026-09-28. **Date:** 2026-09-28. **Design:** TikTok Shop commerce and account routing  (design note removed). **Supersedes:** nothing. **Relates to:** ADR 0005 (Mercado Livre provider), ADR 0008 (optional commerce).

## Context

Money Maker's commerce entities (`Offer`, `CommercialSnapshot`, `CommercialFact`) are provider-neutral shells, but the fact vocabulary, evidence shape, freshness gate and tool names were built for Mercado Livre. TikTok Shop is a second commerce provider with an in-app destination (product attachment, not a URL), its own seller/SKU/price/commission and a manual-first publishing reality. The same physical product can exist in both marketplaces with different commercial facts.

## Decision

1. Keep one `Offer` per (workspace, marketplace, product). Add `TIKTOK_SHOP` to `OfferMarketplace` and a nullable `externalProductId` on `Offer`. No marketplace-specific entities and no binding table now.
2. Make commercial fact vocabulary and the publish freshness policy marketplace-scoped. A snapshot's facts belong to exactly one marketplace.
3. Add a channel × marketplace destination rule: Mercado Livre snapshots publish as external links where the channel supports a link; TikTok Shop snapshots publish only to TikTok channels through manual product attachment until a programmatic path is proven.
4. TikTok Shop eligibility is recorded as an operator observation in `Channel.context.shopStatus`, never inferred, with a dated source and a recheck hint. Automatic detection is provider-dependent and is not claimed.
5. The first TikTok Shop delivery is a manual pilot: Money Maker prepares, the operator attaches and publishes in the TikTok app, and performance is imported from the Affiliate Center export as dated observations.

### Amendment 2026-10-01: Mercado Livre on `tiktok_video`

The owner decided that the package pain Reels also go to TikTok. A Mercado Livre snapshot may bind to a `tiktok_video` variant with destination `profile_link`: the caption carries no URL and no `{link}` (TikTok captions have no clickable links), and the viewer reaches the offer through the profile, either the Instagram icon or the bio link. `create_content_variant` refuses a link in that caption with `CAPTION_LINK_NOT_ALLOWED`. `tiktok_photo_post` stays unsupported for Mercado Livre until a requirement needs it. Rollback: return `unsupported` for `tiktok_video` in `commerceDestinationFor`; existing variants keep their records.

## Consequences

- Positive: no duplication of approval, freshness or snapshot logic; cross-marketplace fact leakage is a testable invariant; the rail can start without any TikTok API approval.
- Negative: manual steps for attachment and performance import; two fact vocabularies to maintain; enum value cannot be removed on rollback.
- Deferred: `ContentCommerceBinding` (S9) if 0..n offers per item is needed; TikTok OAuth/Direct Post adapter; Affiliate API adapter; automatic eligibility read.

## Alternatives rejected

- Marketplace-specific entities: duplicates lifecycle code for two providers.
- Facts-only without a product ID: cannot re-verify or attach reliably.
- Waiting for S9 bindings: blocks the pilot on an unneeded 0..n model.
