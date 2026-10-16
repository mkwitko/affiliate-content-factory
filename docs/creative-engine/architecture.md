# Creative Engine: gap analysis, architecture and phases

Date: 2026-10-06. Status: proposed (ADR 0014). Read with `current-state.md`.

## 1. Gap analysis (what to reuse, what to add)

Reuse as the base (do not rebuild):

- Evidence gates for copy: `numbersWithoutEvidence`, `copyTextCode`, `validateSlideSpec`,
  `validateSlideDeckQuality`, offer commercial facts with source and verification.
- `buildPostCreatives` -> `creativeSlides` on the content item -> `render_creatives` job.
- `renderCreatives` with scene bank, canonical product cutout, product fidelity measurer,
  `brandKitHash`, `RENDERER_VERSION`, render quality report.
- Prepublish score, approval and editorial review, publication policy, Post for Me publisher.
- `CreativeFeatures`, `ExperimentArm`, learnings (`MIN_ARM_OBSERVATIONS = 8`), format director.
- Model policy, generation policy (`local_only`), home worker task API, stage artifact cache.
- The sd.cpp FLUX.2 Klein reference editor and the in-scene overlay (bench-only today).

Gaps that block a mature engine (in priority order):

| # | Gap | Effect today |
|---|---|---|
| G1 | No production path for a generated scene as the slide background | the approved Klein look exists only in `post-preview` |
| G2 | No persisted composition record; `pickScene` is not pinned | a re-render can pick another scene; a creative cannot be explained |
| G3 | Price and discount reach the renderer as free badge text (validated, but written by copy) | the renderer cannot redraw a price change by itself |
| G4 | BrandKit is palette + mark + font; sizes, radii, halos are magic numbers | sub-brands cannot be tuned without code |
| G5 | No platform safe zones, counter always drawn, CTA fixed per Instagram | "1/1" appears; CTA can promise a workflow that does not exist |
| G6 | No in-scene product fidelity check | a Klein scene can change the product unnoticed |
| G7 | Slide QA is a margin check; no contrast, no OCR, report not persisted | legibility and text errors are caught only by people |
| G8 | Affiliate characters are free text + sheet ids; no reference pipeline in production | characters drift between creatives |
| G9 | Variants carry no automatic `creativeFeatures` | learnings never get input |

Resolved 2026-10-06 (owner): the Instagram CTA is now "🔗 Link na bio". Former finding: the CTA "Comente QUERO que te envio o link no
Direct" promises a DM. No comment automation exists in the repo, so a person must answer every
comment. The CTA policy below makes that explicit instead of assuming it.

## 2. Architecture

One sentence: **local AI produces raw art; Money Maker composes, checks and records the final
creative deterministically.**

```text
Offer + verified facts --> CreativePlan (copy, layout family, scene brief)   [LLM, schema-validated]
                       --> Art layer: scene asset (no text)                   [local diffusion, home worker]
                       --> Product layer: in-scene (gated) | real cutout composite
                       --> Composition: CreativeDocument + renderer           [deterministic]
                       --> Quality report (file, layout, contrast, OCR, fidelity, VLM advisory)
                       --> Approval tier (REVIEW_REQUIRED default) --> publish --> metrics --> learnings
```

Principles:

1. Diffusion never draws text, prices, logos or disclosure. The renderer draws every glyph.
2. Commercial numbers come only from verified offer facts, computed in code
   (`PriceDisplay`), never from copy text. The renderer refuses a price without evidence.
3. Every rendered asset stores its `CreativeDocument`: re-rendering a new price, CTA or format
   reuses the pinned scene and never regenerates art.
4. The product is the commercial truth. An in-scene product passes a fidelity gate or falls back
   to the real photo composited over the scene; if neither passes, the creative is BLOCKed.
5. Tokens, presets and policies are data (code defaults + niche `brandKit` context overrides),
   not numbers inside renderers.
6. Human approval stays. AUTO_APPROVE is a future policy tier with high thresholds and never
   applies when commercial facts are stale or fidelity is unproven.

### Schemas (TypeScript types in `packages/core/src/creatives/`)

```ts
type PriceDisplay = {            // computed from offer facts, never from copy
  current: Money; original?: Money; discountPct?: number;  // only when both prices are verified
  freeShipping?: true;                                      // only when the fact is verified true
  source: { factKeys: string[]; snapshotId: string; verifiedAt: string };
};
type PlatformPreset = {          // per channel kind
  id: "instagram_feed" | "instagram_story" | "tiktok_photo" | "threads";
  canvas: { w: number; h: number }; safe: Zone; uiBlocked: Zone[];
  counter: "never" | "carousel_only"; cta: CtaPolicy;
};
type CtaPolicy = { allowed: ("comment_keyword" | "link_in_bio" | "see_offer" | "save_post")[];
                   default: CtaKind; requiresWorkflow?: Partial<Record<CtaKind, string>> };
type DisclosurePolicy = { text: "#publi"; minPx: number; minContrast: number; placement: Zone[] };
type BrandTokens = BrandKit & {  // extends today's BrandKit; defaults = current numbers
  type: { headlinePx: [min: number, max: number]; bodyPx: number; weightHeadline: number };
  shape: { radius: number; pillPadding: number; haloPx: number; shadowOpacity: number };
  palette: BrandKit["palette"] & { dark: string; light: string };
};
type CreativeDocument = {        // persisted in rendered asset metadata (no new table yet)
  version: 1; rendererVersion: number; brandKitHash: string; preset: PlatformPreset["id"];
  layoutFamily: LayoutFamilyId;
  layers: { scene?: { assetId: string; checksum: string }; product: { mode: "in_scene" | "cutout" | "framed"; assetId?: string };
            logo?: { assetId: string } };
  copy: SlideSpec; price?: PriceDisplay; cta?: { kind: CtaKind; text: string };
  boxes: Record<"logo" | "headline" | "body" | "price" | "cta" | "disclosure" | "subject", PixelBox | undefined>;
  quality?: CreativeQualityReport;
};
type ProductVisualSpec = {       // Phase C; derived from listing photos + verified facts, reviewable
  canonicalAssetIds: string[]; dominantColors: string[];
  criticalFeatures: { key: string; value: string | number; factKey?: string }[]; // e.g. shelves: 3
  forbiddenMutations: string[];  // e.g. "screen", "extra drawer"
};
type CharacterBible = {          // Phase D; extends niche context characters, affiliate cartoon cast
  key: string; name: string; sheetAssetIds: string[]; appearance: string;
  wardrobe: string; allowedExpressions: string[]; forbiddenChanges: string[];
};
type CreativeQualityReport = {
  verdict: "pass" | "warn" | "block"; score: number;
  checks: { id: string; result: "pass" | "warn" | "fail" | "n/a"; weight: number; detail?: string }[];
};
```

Weights for the quality score live in one exported table next to the checks, like
`prepublish-score.ts` does today, and are versioned.

### Product fidelity decision (needs the owner)

| Option | Look | Fidelity | Cost |
|---|---|---|---|
| A. Klein in-scene + fidelity gate, fallback B | best (owner-approved) | gate must be calibrated | fidelity checker work |
| B. Scene without product + real cutout composite with shadow | owner rejected "cut-out" look on 2026-09-29 | exact pixels | lighting mismatch |
| C. Klein in-scene, always human-reviewed | best | person checks each one | owner time |

Recommendation: **A with C as the starting point**. Ship in-scene creatives as
REVIEW_REQUIRED (the owner already approves every post), record the reviewer's product verdict as
calibration labels, and turn on the automatic gate (colour/shape similarity on the product
region + VLM advisory + ProductVisualSpec counts) only after it matches those labels.

## 3. Phases (small, reversible, each ends with `pnpm check`)

| Phase | Delivers | Depends on |
|---|---|---|
| **A. Foundation** | A1 platform presets + counter rule + CTA/disclosure policies; A2 BrandTokens with today's numbers as defaults, per-niche palettes as niche `brandKit` data; A3 `PriceDisplay` from facts, renderer draws price from it; A4 `CreativeDocument` persisted on every rendered asset, scene pinned; A5 production in-scene path: a slide may carry `sceneAssetId`, `render_creatives` renders it with the in-scene overlay | none |
| B. Layout | layout families (6 to start: character+product, product hero, problem/solution, price drop, benefit card, minimal), anchor/constraint solver, collision with subject boxes, preset safe zones enforced | A |
| C. Product fidelity | ProductVisualSpec, in-scene gate calibrated on owner verdicts, cutout fallback | A |
| D. Characters | CharacterBible for Carla/Bia/Rafa and casts from existing sheets; Klein reference task on the home worker (`generate_scene_with_refs`), pending_review like plates | A, C |
| E. QA | contrast and disclosure checks, OCR of rendered text (local tesseract), persisted quality report, approval tiers mapped onto existing verdicts | A, B |
| F. Variants | hook library (categories), CreativePlan from the Scene Director / copywriter path, novelty check (perceptual hash + layout id + hook similarity), generation budget | B, E |
| G. Analytics | `creativeFeatures` filled automatically from the CreativeDocument (hook type, layout family, product area ratio, headline length, CTA kind), learnings by vertical and channel | A, F |
| H. Optimization | 80/20 exploit/explore using learnings once arms reach the minimum sample | G + data |

Not now (simplicity test fails): Creative Ops dashboard (MCP status + preview pages cover it),
IP-Adapter/InstantID/PuLID/ControlNet (Klein references already give owner-approved consistency
on 8 GB; revisit only if Phase D measurements show drift), ML ranking, new tables.

### Phase A status (2026-10-06)

- [x] A1 `platform-presets.ts`: presets, counter rule, CTA and disclosure policies; used by the in-scene overlay (no `1/1`, `#publi` >= 28 px with a contrast check, story UI bands kept free).
- [x] A2 `BrandKit.tokens`, `palette.dark/light`; defaults are the former overlay constants (headline sizes now step linearly between `headlineMaxPx` and `headlineMinPx`). `update_brand_context` / niche `brandKit` accept the new optional fields.
- [x] A3 `priceDisplayFromFacts` + `formatMoney`; the overlay draws the price pill from it.
- [x] A4 `creativeDocument` in every rendered asset's metadata; scenes are pinned per content item and slide index.
- [x] A5 `SlideSpec.sceneAssetId` (optional on `build_post_creatives`): in-scene render, always `warn` / `in_scene_unverified` fidelity so a person reviews the product.
- Not done: `quality` report is Phase E. (`CreativeDocument.boxes` for in-scene slides: done in Phase B below.)

### Phase B status (2026-10-06, owner feedback: text over faces, soft images)

- [x] Subject boxes: the fidelity VLM answer carries optional `subjects` (`face` / `person` / `product`, `[x0, y0, x1, y1]` integers 0..1000, Qwen3-VL grounding, at most 8; an invalid list is dropped whole and never changes the verdict). Stored with the scene's `inSceneFidelity.vlm`; `fidelity-bench` records them and writes `images/<caseId>.subjects.json`.
- [x] `subject-layout.ts`: per overlay stack (top: logo + headline; bottom: price, body, CTA, disclosure) picks a placement (`top`, `bottom`, `left-column`, `right-column`; the bottom stack stays at the bottom) and a font scale (1, 0.9, 0.8) so no text box touches a face, the top 30% of a person or more than 5% of the product; otherwise the headline goes on a white card at 0.8 in the least-overlapping placement and the remaining `collisions` are reported. Knobs in `SUBJECT_LAYOUT`. Without subjects the overlay output is unchanged.
- [x] `renderCreatives` passes the stored boxes; the `CreativeDocument` records every drawn box (`boxes`) and the chosen `subjectLayout`. `post-preview` reads the sidecar.
- [x] Scene prompts carry a composition clause (`SCENE_COMPOSITION`): feed keeps the upper third calm with no faces, story keeps the top and bottom quarters calm.
- [x] Desktop upscale: `desktop.sh ampliar` runs Real-ESRGAN ncnn Vulkan x2 (`realesr-animevideov3`) into `edit-bench-out/images-2x/`; `post-preview` prefers it.
- Not done: layout families and preset safe-zone solver beyond the two stacks; the counter pill is not part of the collision check. Follow-up: wire production `upscale_assets` (home-worker task with Real-ESRGAN on offer scenes before `render_creatives`); production scenes are still lanczos-upscaled from 512 px.

### Phase C status (2026-10-06, owner: automatic check, no owner review)

- [x] `in-scene-fidelity.ts`: `productVisualSpecFor` (counted features from verified title/facts), `vlmFidelityPrompt` + strict parser, `judgeInSceneFidelity` (block on differing product, count mismatch, invented text/logo, colour mismatch; pass needs VLM and colour; missing VLM is review). Thresholds in `IN_SCENE_FIDELITY_THRESHOLDS`.
- [x] Colour evidence: `sharp-colour-evidence.ts` (providers), scoring in core.
- [x] `renderCreatives` judges a stored `inSceneFidelity` result (`{ vlm, colour? }`) in the scene asset metadata; without it the slide stays `warn` / `in_scene_unverified`. block maps to the existing fidelity block (approval refuses).
- [x] `pnpm fidelity-bench` / `desktop.sh fidelidade`: Qwen3-VL 4B, 6 positives and 12 swapped-product negatives; gate: positives accepted >= 5/6, negatives blocked 12/12; `promoted` is always false.
- [x] Calibrated on the desktop 2026-10-06 (Qwen3-VL 4B Q4_K_M + mmproj Q8_0, llama.cpp b11417 Vulkan): positives 6/6 accepted, swapped negatives 12/12 blocked, 0 parse failures, p50 4.8 s, p95 17.1 s. The first run blocked both Casa scenes correctly: the scene prompt said "white rack" while the listing photo is black, and Klein followed the text. Lesson recorded for Phase D: product wording in scene prompts must come from the listing (visual spec, dominant colours), never be hand-written.
- Not done: the production producer of `inSceneFidelity` (home-worker scene task, Phase D).

## 4. Risks

- In-scene product drift (G6): mitigated by REVIEW_REQUIRED until the gate is calibrated.
- Desktop throughput: about 3 min (feed) and 5.5 min (story) per Klein scene; a 5-slide story is
  ~25 min of GPU. Plan night batches; reuse art across formats (layered rendering).
- Upscaling 512 px art to 1080 px softens detail; the desktop preview uses Real-ESRGAN x2 (`ampliar`), production `upscale_assets` is the follow-up.
- CTA promising a DM without automation: resolved 2026-10-06, Instagram uses link-in-bio.
- Font metrics: wrapping uses estimated glyph widths; Phase E OCR catches clipped text.

## 5. Definition of done (per creative)

Correct canvas and ratio; scene asset valid and pinned; product mode recorded and either
fidelity-gated or human-reviewed; price/discount from `PriceDisplay` only; no text overflow or
collision; safe zones respected; allowed CTA; legible `#publi`; CreativeDocument and generation
provenance persisted; quality report attached; tests and `pnpm check` green.

## 6. Benchmarks

`pnpm creative-bench` (Phase E): golden set of the six approved Klein scenes (Casa, Beleza,
Tech; feed and story) rendered through the production renderer; metrics: renderer success, QA
pass rate, typography failures (overflow, clipping, contrast), commercial data failures, time per
render. Generation benchmarks stay in `edit-bench` / `image-bench` (desktop).
