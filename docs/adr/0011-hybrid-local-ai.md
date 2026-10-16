# ADR 0011: Hybrid local AI behind existing ports

Date: 2026-09-30
Status: accepted

## Context

The owner has four machines: a Mac mini M4, a Windows desktop with an AMD RX
6650 XT (8 GB), a MacBook Air M1 (16 GB) and the production cloud ARM VM
(2 OCPU, 12 GB, ARM64, no GPU). The 2026-09-30 code audit
(`docs/audits/2026-09-30-local-ai-code-audit.md`) established that:

- The server never calls a language model. ChatGPT, as the MCP client, writes
  all prose and the server validates it with fixed rules.
- Narration is already local: Kokoro runs as a CPU sidecar on the production
  host and returns word timestamps that drive captions and stickman motion.
- Image and video work is deterministic (sharp, SVG, ffmpeg). Remotion is not
  in the repository. The only paid generation call is Cloudflare Workers AI
  FLUX.1 schnell for scene backgrounds, inside a 10,000 neuron/day free tier.
- The worker talks to Neon Postgres and R2 directly. There is no worker
  identity, no capability-aware job claim and no heartbeat.

Local inference therefore cannot "replace paid APIs" in any meaningful amount;
the marginal API spend per video is already close to zero. What local machines
can add is capacity (the A1 shares 2 OCPU between API, worker and Kokoro),
quality tooling (segmentation, fidelity checks) and control (offline,
reproducible models).

## Decision

1. **Deterministic before model.** Every task first gets the cheapest
   deterministic fix. The first shipped change under this ADR is a pt-BR
   spoken-form normalizer (`packages/core/src/assets/spoken-text.ts`) wrapped
   around the `SpeechSynthesizer` port, because measured Kokoro output
   mispronounced prices, decimals and thousands separators.
2. **Local models enter only behind existing ports.** `SpeechSynthesizer`,
   `SceneGenerator`, `ReelRenderer`, `ClipRenderer`, `CreativeRenderer` and the
   cutout function injected into `ensureCanonicalProduct` are the seams. New
   ports are added only when a task has no port today (segmentation, vision
   QA, text generation) and only together with a fake adapter for tests.
3. **The cloud VM orchestrates, it does not infer.** No model larger than the
   existing Kokoro CPU sidecar runs on the production host. Language, vision
   and image models run on the owner's machines or not at all.
4. **Local machines are optional pull workers.** They connect outbound to
   Neon and R2 with the existing worker binary, claim only the job names they
   register, and never expose an inference endpoint to the internet. Their
   absence must not stop publishing: the production worker keeps every job type
   it runs today.
5. **ChatGPT stays the author.** No local language model writes customer-
   facing copy until it passes the same fixtures as the current path. Local
   language models are candidates for review analysis, classification and
   structured extraction only, with grammar-constrained JSON validated by the
   existing Zod schemas.
6. **Product pixels are never generated.** Image generation, local or remote,
   only produces surroundings. Any future fidelity check compares the
   composited product region against the listing photo with deterministic
   metrics first and learned embeddings second.
7. **Licences are checked per weights and per runtime** before a model is
   adopted, and the model name, version, licence and runtime are recorded with
   each produced asset, as ADR 0009 already requires for scenes.

## Consequences

- Cost savings from local inference are cents per week and are not a goal.
  Decisions are made on capacity, quality and reliability.
- Running the worker on a second machine needs three small changes first:
  claim filtering by registered job name, a render-only environment profile
  that does not require Auth0 variables, and a restricted database role.
  These are planned in
  `docs/superpowers/specs/2026-09-30-hybrid-local-ai-design.md`.
- Every adopted local model ships with a benchmark script under
  `scripts/local-ai/` and a row in the spec's measured table. Rows without a
  measurement stay marked "not verified".
- ADR 0009 remains in force for scene generation and product fidelity.

## Amendment 2026-09-30: video generation

`docs/superpowers/specs/2026-09-30-ai-video-generation-design.md` extends this
decision to video: `stickman_motion`, `ReelRenderer` and `ClipRenderer` stay the
renderers; a local scene director gets its own minimal `SceneDirector` port
(the existing `SceneGenerator` port generates images, not storyboards); product
photography is never altered by generative models and is gated by
deterministic fidelity metrics; Remotion and generative video remain
experiments behind measured benchmarks. Local generation is adopted per
capability on a quality win, not on cost.
