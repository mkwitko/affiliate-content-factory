# Creative pipeline: current state audit (HEAD cd81b96)

Scope: affiliate creatives (carousel, stories, TikTok photo) plus the shared brand, generation and QA layers. Paths are relative to `packages/core/src` (`core/`), `packages/providers/src` (`prov/`) or `apps/`. Status: **exists** / **partial** / **missing**. "Not found" means a repo search returned nothing.

## 1. Affiliate creative flow

| Stage | Where | Status |
|---|---|---|
| Offer + commercial facts (`current_price`, `list_price`, `free_shipping`, ratings, sold counts), verified flag, per-snapshot | `core/offers/commercial-facts.ts:13-24,60`, `core/offers/offer.ts:10` (`CommercialFact`), freshness `core/offers/publish-freshness.ts:6-13` | exists |
| Copy draft by local LLM (`draft_offer_copy` home task), 6 slides, IG + Threads captions only | `core/content/offer-copy.ts:22-24`, `core/home-worker/tasks.ts:105` | exists |
| Copy gates: links, @mentions, unverified shipping/discount (`copyTextCode`), numbers vs facts, hashtags, fixed CTA + `#publi` appended | `core/content/offer-copy.ts:130-210` | exists |
| `numbersWithoutEvidence` (price, %, counts, ratings backed by facts) | `core/content/preview-content.ts:45` | exists |
| `build_post_creatives`: validates slides, deck quality, claim factKeys, numbers, offer snapshot still valid; stores `creativeSlides` on the content item; creates one variant per channel; enqueues `render_creatives` | `core/creatives/build-post-creatives.ts:51-149` | exists |
| `SlideSpec` (index, total, template, headline, body, badge, disclosure, claims) + limits 60/140/40 chars, generic-hook and repeated-copy rejection | `core/creatives/slide-spec.ts:3-69` | exists |
| `render_creatives`: canonical product, scene pick, per-channel brand merge, render, asset create, fidelity report on variant | `core/creatives/render-creatives.ts:106-404`; worker wiring `apps/worker/src/main.ts:415-450`; canvas choice `apps/worker/src/handlers/render-creatives.ts:14` | exists |
| Templates (6 ids, fractional zones, feed 1080x1350, story 1080x1920) | `core/creatives/templates.ts:4-144` | exists |
| Layout helpers (`fitHeadline`, `placeProduct`, `judgeLayout` margin check only) | `core/creatives/layout.ts:27-88` | partial |
| Sharp renderer: scrim, cutout/framed product, shadow, logo mark, counter, headline, body, price badge | `prov/media/sharp-creative-renderer.ts:174-334` | exists |
| In-scene overlay (logo badge, two-tone headline with halo, price pill "De R$ X por R$ Y", body card, disclosure tag, story CTA pill) | `prov/media/in-scene-overlay.ts:82-224`; switch at `sharp-creative-renderer.ts:184-193` | exists, **not wired to production**: only `apps/worker/src/commands/post-preview.ts:166` passes `inScene: true`; `render-creatives.ts:286` always passes a cutout/framed product |
| Canonical product: classify, local white-bg cutout or optional AI segmenter (`SEGMENTER_CMD`), QA, fallback to framed original, cached by checksum + `CUTOUT_VERSION` | `core/creatives/canonical-product.ts:59-215`, `core/creatives/cutout-qa.ts:10-69`, `prov/media/command-image-segmenter.ts` | exists (segmenter off unless configured, `main.ts:385`) |
| Scene bank `pickScene`: pool min 8, 60-day age, least-used outside last 5, generate under budget, else procedural fallback | `core/creatives/scene-bank.ts:55-56,92-200`, `core/creatives/scene-plan.ts` | exists |
| Product fidelity (mask IoU, deltaE, MS-SSIM, edge recall) with provisional thresholds; unmeasured never passes | `core/creatives/product-fidelity.ts:61-136`, `prov/media/sharp-fidelity-measurer.ts:266` | exists (thresholds provisional) |
| Prepublish score (hook opener, CTA, price freshness, fidelity, render QA; hard fails block) | `core/content/prepublish-score.ts:41-135`, inputs `apps/api/src/prepublish.ts:26` (computed on read/approval, never persisted) | exists |
| Approval refuses `fidelity_blocked`, `prepublish_blocked`, `ai_disclosure_missing`, unverified clip rights | `core/content/approval.ts:69-120` | exists |
| Editorial review (counting review, policy version) | `core/content/editorial.ts:146-194` | exists |
| Publish via Post for Me; manual-only stories | `prov/post-for-me/social-publisher.ts`, `apps/worker/src/handlers/publish-content.ts`, `core/channels/channel.ts:137` | exists |
| Metrics at 1/3/7/30 days; attribution by click redirect | `core/analytics/performance.ts:70-111`, `core/analytics/attribution.ts` | exists |
| Learnings, format director, creative intelligence | `core/analytics/learnings.ts`, `core/content/format-director.ts`, `core/analytics/creative-intelligence.ts` | exists (see 8) |

Flow gaps: `build_post_creatives` creates variants without `creativeFeatures` (`build-post-creatives.ts:114-123`); features are only set when an operator passes them to `create_content_variant` (`apps/api/src/mcp/tools/create-content-variant.ts:63,323`). `core/creatives/creative-brief.ts` builds a brief (angle, hook strategy, CTA) from buyer voice but nothing downstream consumes it as a render input.

## 2. Brand

- `BrandKit` (`core/brand/brand-kit.ts:3-22`): logo light/dark asset ids, palette (primary, secondary, accent, surface, text, muted), typography (`Inter` only, weights), mark (position, minWidth, safeMargin), brandName, nicheLabel. Default `:29`. Merge order workspace, niche, channel (`render-creatives.ts:202-206`); hex validation; `brandKitHash` (`:82`). Update schema `apps/api/src/mcp/tools/editorial-context.ts:44`.
- Logos: imported as asset role `logo` (`import-asset-from-url.ts:18`); only `logoLightAssetId` is read by `render-creatives.ts:209`; `logoDarkAssetId` is unused by the image renderer.
- Caption themes: 5 presets, 3 fonts, WCAG 4.5 contrast check, fallback to `word_pop` (`core/brand/caption-style.ts:4-178`). Video mark plan: `core/brand/video-mark.ts:23`.
- Tokens vs magic numbers: palette, mark safeMargin and brand name are tokens. Spacing, font-size ratios (0.085/0.075/0.065, 0.09...0.055), pill sizes, shadow, scrim opacity (.75/.85), fixed `#fff`/`#000` fills, 0.6/0.58 glyph-width factors and per-canvas zone fractions are hardcoded in `layout.ts:33`, `templates.ts`, `sharp-creative-renderer.ts:53,267`, `in-scene-overlay.ts:5-6,29-210`. No type scale, spacing scale or radius tokens.

## 3. Characters

- Niche context `characters[]` (name, role main/secondary/pet, description, `referenceAssetIds` max 4, plus stickman rig fields and `bible`) at `apps/api/src/mcp/tools/editorial-context.ts:133-170`; `storyWorld` string at `:130`. Asset role `character` imported via `import_asset_from_url` (`:18`, `routes/assets.ts:56`).
- `get_generation_context` returns the cast with signed `referenceUrls` per sheet (`apps/api/src/mcp/tools/get-generation-context.ts:84-98`); that is the only way sheets reach ChatGPT-side generation. Story assets and `get_story_kit` handle manual posting of slides (`create-story-assets.ts`, `get-story-kit.ts`); `story-image-composer.ts` turns 4:5 into 9:16 by blurred-fill.
- Explainer character bible (archetype, head shape, role, voice, relationships) `core/explainer/character-bible.ts:9-80` is stickman-only; deterministic rigs, wardrobe, continuity facts `core/story/continuity.ts`.
- Reference-conditioned generation: `SceneGenerator.generate(..., {reference})` and `ImageEditor.edit(prompt, 1..4 refs)` (`core/creatives/scene-bank.ts:24-43`), sd.cpp editor with FLUX.2-klein-4B (`prov/media/sdcpp-scene-generator.ts:293`, profile `core/assets/model-policy.ts:143`). Used by `edit-bench` and `post-preview` benches only; no production affiliate path consumes `referenceAssetIds` for image generation. Clip generation requires a reference (`home-worker/tasks.ts:418`). Affiliate cartoon-character bible: **missing** (free-text description only).

## 4. Generation

- Scene generators: Workers AI FLUX schnell (`prov/cloudflare/workers-ai-scene-generator`), local command generator with `--seed`, `--reference` (`prov/media/command-scene-generator.ts:13-81`, seed derived from prompt hash), sd.cpp generator/editor, chosen in `apps/worker/src/scene-generator.ts:15-43` (local command first, Workers AI unless `local_only`).
- Video: Agnes (`agnes-video-2.5-flash`, `prov/media/agnes-scene-clip-generator.ts:16`, key withheld under `local_only` `scene-generator.ts:45`), local Wan 2.2 via sd.cpp, shipped disabled (`model-policy.ts:149`, `scene-generator.ts:56`).
- Policy: `GENERATION_POLICIES = local_only | local_first | cloud_allowed` (`core/assets/generation-policy.ts:1`); `MODEL_PROFILES` with capability, licence policy, enabled/experimental (`model-policy.ts:11-110`).
- Home worker tasks (ADR 0012): `direct_scenes`, `generate_plates`, `review_frames`, `draft_offer_copy`, `generate_clips` (`core/home-worker/tasks.ts:78-130`). Affiliate path uses only `draft_offer_copy` and `generate_plates`.
- Scene prompts: one fixed template, empty surface plate, "no product, no text, no people" (`core/creatives/scene-plan.ts:12`, `SCENE_PROMPT_VERSION=2`); only 4 surfaces and 3 lightings; role hero/secondary. Plate requests `core/creatives/fill-scene-bank.ts:55`.
- Scene Director: structured, schema-validated, correction loop, llama-server provider (`core/explainer/scene-director.ts:27-76`, `prov/llm/llama-server-scene-director.ts:186`), explainer only.

## 5. QA

- Render QA report (container, dims, fps, duration, loudness, silence, black, freeze, visual section, VLM record, cache counts) `core/publishing/render-quality.ts` (video only).
- Visual QA: scene-graph and frame findings, safe-box and caption contrast 4.5 (`core/explainer/visual-qa/*`, `tunables.ts:20`); VLM frame review advisory only (`visual-qa/vlm-review.ts:5`, `prov/llm/llama-server-frame-reviewer.ts`); both stickman video, not slides.
- Slides: `validateSlideDeckQuality`, `judgeLayout` margins, headline fit errors (`layout_failed:*`), `bodyDropped` flag, product fidelity, cutout QA. Renderer self-check is structural (`prov/media/creative-renderer-self-check.ts:29`).
- OCR: not found. Contrast QA on slides: not found (contrast only for caption themes and video captions). Text-over-scene legibility is by white halo/pills, not measured. Safe zones: only `SAFE_BOX` for explainer (`core/explainer/layout.ts:7`) and uniform `safeMargin` 0.06 for slides.

## 6. Reproducibility and provenance

- Scene assets store `prompt`, `seed` (when generator reports), `model`, `promptVersion`, `postProcess`, `homeWorker` review, `sceneKey`, licence, fingerprint (`core/creatives/scene-bank.ts:152-176`). Canonical cutout stores `sourceChecksum`, `cutoutVersion`, `mode`, `cutoutMethod`, `segmentConfidence` (`canonical-product.ts:174-190`).
- Rendered slide asset metadata: `templateId/Version`, `rendererVersion`, `brandKitHash`, `sceneAssetId`, `canonicalAssetId`, `fallbacks`, nicheId, content/channel ids (`render-creatives.ts:296-309`). Variant `creativeRender` stores templateVersions, rendererVersion (constant `1`, `creative-renderer.ts:30`), brandKitHash, fidelity.
- `SlideSpec[]` is persisted on the content item (`creativeSlides`, `build-post-creatives.ts:109`), the scene and canonical are referenced by id: text re-render without regeneration is possible by re-running `render_creatives`, but `pickScene` re-picks (not pinned to the stored `sceneAssetId`) and the final composition record (zones, font sizes, layer list) is not stored, only `headlineFontSize`/`bodyDropped` in memory.
- Stage artifact cache (`core/assets/stage-cache.ts:14-64`) is used for TTS, clips, long-form; not for the affiliate render.
- No per-creative spec document with prompt compile inputs, no model profile id on the rendered asset, no unified reproducibility record.

## 7. Platform formats

- Channel kinds: instagram_carousel, instagram_stories, instagram_reels, threads, tiktok_photo_post, youtube, tiktok_video (`core/channels/channel.ts:5-12`). Capabilities (max assets, caption limit, required dimensions): carousel 10/2200/1080x1350, stories 10/1000/1080x1920, reels 2200 1080x1920, threads 500, tiktok_photo 35/4000/1080x1920, youtube 5000, tiktok_video 2200 (`channel.ts:45-92`).
- Canvas: story for stories and tiktok_photo_post, feed for the rest; reels/tiktok_video skipped by the slide job (`handlers/render-creatives.ts:14-25`); Threads keeps cover only (`render-creatives.ts:348`).
- CTA: `INSTAGRAM_CTA = "💬 Comente QUERO que te envio o link no Direct"` appended (`offer-copy.ts:29,201`); preview warns `cta_missing` for carousel and reels (`preview-content.ts:128,147,283`); stories get `cta.mode: "link_in_bio"` (`:322`); in-scene story CTA pill takes a free-text `cta`. TikTok link-in-bio caption text: not found; TikTok caption links produce a warning (`:167-170`).
- Disclosure: `disclosurePolicy` per channel (`core/creatives/disclosure.ts:4-15`), applied to the slide only for the `cta` template (`render-creatives.ts:281`); caption `#publi` appended (`offer-copy.ts:203`), `disclosure_missing` warning (`preview-content.ts:133`), YouTube text constant (`:135`).
- Slide counter `index/total` is always drawn (`sharp-creative-renderer.ts:98`, `in-scene-overlay.ts:125`), including stories and TikTok photo; no per-platform rule. Platform UI safe zones for slides (stories top/bottom bars): not found.

## 8. Experiments and analytics

- `CreativeFeatures` (hookMove, angle, proofType, urgency, priceShown, discountShown, ratingShown, format, durationSec, experiment) `core/content/content.ts:80-91`; `ExperimentArm` `:78`; `learningFeatures` `:67-76`.
- `computeLearnings`: arm comparison per platform and checkpoint, `MIN_ARM_OBSERVATIONS = 8`, status learning/insufficient_data, confidence always "directional" (`core/analytics/learnings.ts:39-177`).
- Format director: seeded, exploration rate 0.25, rotates hook moves, picks experiment key/arm, trial-renderer opt-in (`core/content/format-director.ts:29-161`); renderer catalog `core/content/renderer-catalog.ts`. Variant experiment guard in `create-content-variant.ts:186-213`.
- Creative intelligence pattern summaries by channel, age, feature (`core/analytics/creative-intelligence.ts:52`). Attribution groupBy publication/variant/contentItem/niche/channel (`attribution.ts:30`). Metrics shape `performance.ts:7`.
- Feature metadata absent: layout/template id, scene id, character, palette, text density, hook library type (affiliate uses 4 `hookMove`s; explainer has 12 `HOOK_TYPES`, `core/explainer/hook-library.ts:2`).

## 9. Status table

| Item | Status | Where |
|---|---|---|
| BrandKit tokens | partial (colour, mark, name only) | `core/brand/brand-kit.ts:3` |
| CreativeSpec / source document | partial (`SlideSpec` only, no scene/layout/model fields) | `core/creatives/slide-spec.ts:3` |
| Layout engine / collision | partial (zones + margin check; no text/product collision) | `creatives/layout.ts:69`, `in-scene-overlay.ts:216` |
| Safe zones per platform | missing (uniform 6% margin; explainer SAFE_BOX only) | `explainer/layout.ts:7` |
| Counter rule | partial (always drawn, no rule) | `sharp-creative-renderer.ts:98` |
| Hook library | partial (explainer 12 types; affiliate 4 moves + generic-opener ban) | `explainer/hook-library.ts`, `format-director.ts:10` |
| Layout families | partial (6 templates, only `hero`/`cta` used by preview) | `creatives/templates.ts:4` |
| Typographic hierarchy | partial (hardcoded in renderers) | `in-scene-overlay.ts:64-210` |
| Deterministic price/discount | exists (regex "De R$ X por R$ Y" from badge text; numbers checked vs facts) | `in-scene-overlay.ts:29`, `preview-content.ts:45` |
| CTA policy | exists (IG fixed formula; others none) | `offer-copy.ts:29`, `preview-content.ts:128` |
| Disclosure policy | exists | `creatives/disclosure.ts:4` |
| OCR QA | missing | not found |
| Contrast QA (slides) | missing (captions only) | `brand/caption-style.ts:108` |
| Product visual spec | partial (canonical + fidelity metrics; no per-product descriptors) | `canonical-product.ts`, `product-fidelity.ts` |
| Product compositing | exists (cutout/framed over scene); in-scene variant bench-only | `sharp-creative-renderer.ts:234` |
| Character bible, affiliate cartoon | missing (stickman bible only) | `explainer/character-bible.ts:55` |
| Reference-conditioned generation | partial (editor + benches; not in production affiliate flow) | `scene-bank.ts:35`, `sdcpp-scene-generator.ts:293` |
| VLM reviewer | partial (advisory, stickman frames) | `visual-qa/vlm-review.ts` |
| Quality score | partial (prepublish score, not persisted) | `content/prepublish-score.ts` |
| Layered generation | missing (scene plate + overlay is layered by construction; no per-layer regeneration) | `render-creatives.ts` |
| Reproducibility record | partial (see 6) | `render-creatives.ts:296` |
| Experiments | exists | `format-director.ts`, `learnings.ts` |
| Analytics feature vector | partial (`CreativeFeatures`, operator-supplied) | `content.ts:80` |
| Novelty/repetition check | partial (caption Jaccard >= 0.8 vs last 10, scene least-used, story novelty guard) | `preview-content.ts:184-197`, `scene-bank.ts:93`, `story/novelty-guard.ts` |
| Cache | partial (stage cache not used for slides; canonical + scene bank cached) | `assets/stage-cache.ts` |
| Asset library tags | missing (metadata keys `role`, `sceneKey`, `nicheId` only) | `asset.ts` |
| Creative director (structured plan) | partial (Scene Director for explainer; `creative-brief.ts` unused; affiliate copy by LLM draft) | `explainer/scene-director.ts` |
| Prompt compiler | partial (clip prompt compiler; scene prompt is one template) | `content/clip-prompt.ts`, `scene-plan.ts:12` |
| Model profile | exists | `assets/model-policy.ts:55` |
| Failure-reason retry | missing (render failures are recorded as `failed` with reason, `build-post-creatives.ts:43`; no reason-driven re-layout or regeneration) | `render-creatives.ts:95-104` |
| Approval tiers AUTO/REVIEW/BLOCK | partial (pass/warn/block verdicts, publication/automation policy; no tier object) | `approval.ts:69-120`, `autonomy/cycle.ts` |
| Creative ops dashboard (apps/web) | missing for creatives (panel has review/results; no fidelity, score or experiment view found) | `apps/web/src/features/panel/review.tsx` |
