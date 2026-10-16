# ADR 0005: Mercado Livre catalog provider

Status: accepted.

The catalog adapter uses official Mercado Livre endpoints only. Access tokens are workspace-scoped encrypted secrets; raw provider payloads never cross the provider boundary. Search and detail responses are normalized to title, listing URL, seller, availability, and price evidence. Buyer voice (rating average, reviews split by rating, and buyer questions) is read from the official reviews and questions endpoints for copy research only; buyer text is bounded, whitespace-collapsed, and marked untrusted, and an endpoint the app may not read is reported as unavailable instead of failing. Affiliate destinations are operator-supplied until an approved affiliate API is configured, and every imported offer remains draft until the normal evidence review activates it. Rate limits and provider failures are surfaced without retrying unsafe writes.
