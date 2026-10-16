# ADR 0009: Deterministic creative pipeline

Date: 2026-09-25
Status: accepted

## Context

The OpenAI image generator made slide production provider-dependent and did not
preserve product fidelity. Creative images also need consistent workspace,
niche, and channel branding, with attributable source assets and bounded
generation cost.

## Decision

- Render slides in the worker with Sharp and versioned templates. Merge Brand
  Kit values in workspace → niche → channel order, bundle Inter under its OFL
  license, and record renderer/template versions with each asset.
- Derive the visible product only from an approved Mercado Livre listing photo.
  Ranking, white-background cutout, and QA choose the canonical source; the
  renderer may resize/crop it, apply alpha masking and deterministic shadows,
  but never sends the product region to a generative model.
- Reuse licensed scenes from the Scene Bank. Cloudflare Workers AI through AI
  Gateway fills missing scene keys using FLUX.1 schnell at 4 steps; observed
  usage is 172.8 neurons per 1024×1024 image (about 173). The daily budget
  selects reuse or procedural backgrounds as generation approaches its limit.
- Classify content and renderer failures as permanent, retry infrastructure
  failures at most twice, and block worker startup when fonts or the renderer
  snapshot check fail. Persist source photo IDs, scene IDs, template versions,
  renderer version, Brand Kit hash, and render state on workspace assets and
  variants.
- Apply deterministic affiliate disclosure per channel in the renderer.
  Generated assets remain drafts; a person reviews the preview and approves
  publication.
- Keep the existing Canva and operator-upload routes as explicit manual
  overrides. Retire the OpenAI image generator and its API key configuration.

The owner accepted the affiliate-content compliance risk recorded in §19 of
the autonomous creative pipeline design on 2026-09-25. Product fidelity is the
acceptance boundary: the visible product derives only from the source photo;
generative output is restricted to the background scene.

## Consequences

The default post flow no longer waits for a separate ChatGPT image-generation
step. Scene generation is asynchronous, budgeted, cached, and replaceable by
procedural backgrounds. Startup self-checks make font or renderer drift an
operational error. Manual creative uploads require an operator-confirmed
license. Changing templates or renderer output requires updating the snapshot
and reviewing the fidelity rubric before release.

## Supersedes

This ADR supersedes [ADR 0006: OpenAI image generation](0006-openai-image-provider.md).
