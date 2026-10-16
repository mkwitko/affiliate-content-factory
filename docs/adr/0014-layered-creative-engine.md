# ADR 0014: Layered creative engine — AI makes art, Money Maker composes

Date: 2026-10-06
Status: proposed

## Context

Affiliate slides were made by hand in ChatGPT (quality bar) or by the server compositing a
product cut-out over a generated background (rejected by the owner on 2026-09-29). On 2026-10-06
the owner approved local FLUX.2 Klein scenes that paint the recurring character and the real
product from reference photos, and asked for a mature creative engine. Diffusion models misspell
text and can alter products; commercial numbers must come from evidence.

## Decision

1. Generation produces art only: a scene image with no text, price, logo or disclosure.
2. The renderer composes every final creative deterministically from a `CreativeDocument`
   (scene layer, product mode, copy, `PriceDisplay`, CTA, disclosure, brand tokens, platform
   preset) and persists that document in the rendered asset's metadata. Re-rendering for a new
   price, CTA or format reuses the pinned scene.
3. Prices, discounts and shipping shown on a creative are computed in code from verified offer
   facts; the renderer refuses values without evidence.
4. An in-scene product is checked automatically (owner decision 2026-10-06): verified title
   counts, reference colours and a local VLM comparison against the listing photo. Any failed
   check is BLOCK; a missing VLM answer is REVIEW_REQUIRED, never pass. The gate is used in
   production only after `fidelity-bench` meets its target on the owner's approved scenes.
5. Brand tokens, platform presets, CTA and disclosure policies are data with code defaults.
6. Work proceeds in phases A to H of `docs/creative-engine/architecture.md`; no new service or
   table until a phase proves it is needed.

## Consequences

The ChatGPT manual step can be retired once Phases A, C and D land. Art can be reused across
feed, story and A/B variants. Throughput is bound by desktop GPU time (minutes per scene), so
scenes are batched and reused. Owner decisions 2026-10-06: automatic product fidelity gate; CTA
link-in-bio (no comment automation).
