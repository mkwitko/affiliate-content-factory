# Content generation v2: target architecture

Date: 2026-10-06. Status: proposed. Builds on ADR 0014 (layered creative engine) and
`docs/creative-engine/architecture.md` (Phases A-C done). Facts about today's code are in
`current-state.md` and `docs/creative-engine/current-state.md`.

## 1. One sentence

Facts first, plan before pixels, generate only what generation does better than the real photo,
compose and check deterministically, measure every model per task, and let a person approve.

## 2. Pipeline (stages map to existing modules; new parts in bold)

| # | Stage | Exists in | Change |
|---|---|---|---|
| 1 | Product facts + claim provenance | `core/offers/commercial-facts.ts`, `numbersWithoutEvidence`, `priceDisplayFromFacts` | **claim -> {sourceField, sourceText, confidence}** on copy claims (today: factKeys) |
| 2 | Creative plan (angle, hook, arc, character, product strategy) | `creative-brief.ts` (unused), copywriter `hookOptions`, Scene Director (explainer) | **`CreativePlan`** consumed by render: 3 hooks x 2 arcs scored cheaply, best one drafted |
| 3 | Shot plan | reel = every slide, Ken Burns (`current-state.md` 1) | **`ShotSpec[]`**: purpose, duration, framing, motion, productStrategy, text region, voice text |
| 4 | Layout plan | `platform-presets.ts`, `subject-layout.ts` (Phase B) | **`LayoutSpec` before generation**: reserved text region goes into the prompt composition clause |
| 5 | Model routing | `MODEL_PROFILES`, `generation-policy.ts`, hard-coded generator choice in `apps/worker/src/scene-generator.ts` | **task champion table** (`model-arena.md` 3) consulted by the router; tiers DRAFT/FAST/QUALITY/RECOVERY |
| 6 | Asset generation | home worker `generate_plates`, sd.cpp editor | unchanged contract; new models arrive as profiles + adapters |
| 7 | Product composition | canonical cutout, in-scene fidelity gate (Phase C) | **product strategy router** (below); real product for the offer shot |
| 8 | Visual QA | fidelity gate, subject boxes, VLM advisory | **`QualityState`** collects all checks into one record |
| 9 | Design render | sharp renderer + in-scene overlay + BrandKit tokens | type scale/spacing tokens per vertical (Phase A2 extended) |
| 10 | Motion | Ken Burns alternating, stickman SVG | **motion tiers**: STATIC, KEN_BURNS (eased, 100->106-110%), 2.5D (depth layers), I2V (1-2 s, gated) |
| 11 | Voice | Kokoro v0.9.0, pt-BR spoken form | **DisplayText vs SpeechText** made explicit, speed 0.95-0.98, pauses; TTS arena |
| 12 | Alignment + captions | Kokoro word timestamps, caption themes | ASR check (whisper.cpp) as QA, 2-5 word chunks, max 2 lines |
| 13 | Audio | loudnorm -14 LUFS, TP -1.5, sidechain ducking | music 14-18 dB under voice; LUFS/TP/clipping gates in the render report |
| 14 | Video composition | ffmpeg libx264 yuv420p 30 fps AAC | hook visible at 0 ms, hard cuts, 7-12 visual changes per 15 s |
| 15 | Final QA + decision | prepublish score, render quality report, approval gates | **`ContentQualityReport`** subscores; rules decide; Jev in shadow |
| 16 | Human approval | `approval.ts` | **reason enum** (BAD_PRODUCT ... AI_LOOK) instead of free text |
| 17 | Publish, analytics, learning | Post for Me, metrics 1/3/7/30, learnings | feedback row per output (models, prompt versions, scores, human decision) |

## 3. Product strategy router

Per shot: `GENERATIVE_PRODUCT | REFERENCE_EDIT | REAL_PRODUCT_COMPOSITE | REAL_PRODUCT_HERO`.

Rules (deterministic, from the product visual spec and listing data):

- Offer/price shot: always `REAL_PRODUCT_HERO` (real photo, generated background allowed).
- Transparent, packaging with text, logo, screen, connectors, exact part count, commercially
  important colour, small details: `REAL_PRODUCT_COMPOSITE` unless the in-scene fidelity gate
  has passed this product before.
- Character holding/using the product: `REFERENCE_EDIT` (Klein or the image arena champion) +
  fidelity gate; a fidelity block falls back to `REAL_PRODUCT_COMPOSITE` (smart recovery).
- `GENERATIVE_PRODUCT` only for background props, never the advertised item.

## 4. Contracts (types live in `packages/core/src/creatives/` next to `CreativeDocument`)

```ts
type ProductStrategy = "generative_product" | "reference_edit" | "real_product_composite" | "real_product_hero";
type ShotSpec = {
  purpose: "hook" | "problem" | "escalation" | "discovery" | "benefit" | "proof" | "product_hero" | "offer" | "cta";
  durationMs: number; character?: "carla" | "bia" | "rafa"; productStrategy: ProductStrategy;
  framing: "wide" | "medium" | "close" | "product"; sourceAssetId?: string;  // one master -> many shots
  motion: "static" | "ken_burns" | "parallax_2_5d" | "layer" | "i2v"; transition: "cut" | "fast_fade";
  textRegion?: Zone; voiceText?: string; captionText?: string;
};
type LayoutSpec = {                       // decided before generation
  canvas: { w: number; h: number }; safe: Zone; regions: Partial<Record<
    "character" | "face" | "product" | "headline" | "body" | "caption" | "logo" | "price" | "cta", Zone>>;
  forbidden: Zone[]; negativeSpace: Zone[];
};
type QualityState = {                     // input to rules and to the shadow advisor
  facts: { priceMatch: boolean; unverifiedClaims: string[]; disclosure: boolean };
  license: { allCommercial: boolean; unknown: string[] };
  product: { strategy: ProductStrategy; fidelity?: "pass" | "warn" | "block" };
  layout: { faceTextOverlap: number; productTextOverlap: number; safeZone: boolean; headlineLines: number };
  copy: { hookScore?: number; validator: "pass" | "fail" };
  audio?: { lufs: number; truePeak: number; asrWer?: number };
  video?: { maxStaticMs: number; visualChanges: number; firstFrameHook: boolean };
  generation: { models: string[]; retries: number; totalMs: number };
};
```

`HARD_BLOCKERS` (deterministic, Jev cannot release): PRICE_MISMATCH, UNVERIFIED_DISCOUNT,
UNVERIFIED_CLAIM, PRODUCT_WRONG, LICENSE_UNKNOWN, FACE_TEXT_COLLISION, SAFE_ZONE_VIOLATION,
MISSING_PUBLI, INVALID_OUTPUT, CORRUPTED_MEDIA. Most already exist as approval refusals or
prepublish hard fails; the rest are added as checks in `QualityState`.

## 5. Decisions and learning

- `DecisionProvider` (exists) is the port; implementations: rules (existing gates), Jev (hosted,
  shadow), local LLM (llama-server JSON). No hybrid class until shadow metrics justify one.
- Shadow records joined with owner decisions feed `shadowAgreement`; promotion per decision
  type (rule in `model-arena.md` 5).
- Feedback row per output reuses `CreativeFeatures` and the `CreativeDocument`; adds model ids,
  prompt versions and the human reason enum. Business metrics (CTR, clicks, revenue) join later
  via existing attribution.

## 6. Tiers and recovery

| Tier | Image | Upscale | Motion | When |
|---|---|---|---|---|
| DRAFT | 384-512 px, 1 seed | none | static | plan scoring, layout check |
| FAST | champion, 512x640 / 512x896 | Real-ESRGAN x2 | Ken Burns eased | daily default |
| QUALITY | quality champion, larger native size | arena upscale champion | 2.5D / I2V on 1-2 shots | high expected ROI |
| RECOVERY | reason-aware | | | after a typed failure |

Recovery map: BAD_PRODUCT -> real composite; BAD_CHARACTER -> identity-focused model or more
reference crops; NO_TEXT_SPACE -> re-layout, then regenerate with a stronger composition clause;
BAD_FACE -> other seed, then other model; BAD_VOICE -> alternate TTS; BAD_MOTION -> 2.5D instead
of I2V. Never the same model + prompt + settings twice.

## 7. Safety boundaries (unchanged)

Home worker: no DB or R2 credentials, job input only, outputs `pending_review` and re-validated
server side (ADR 0012). Licence gate in `MODEL_PROFILES`. Nothing publishes without approval.
Feature flags use the existing env schema (`packages/config`): `JEV_ENABLED` (exists), and new
flags only when the code they guard lands (e.g. `REAL_PRODUCT_HERO`, `MOTION_2_5D`).

## 8. What we will not build now (simplicity test)

A separate model-registry service or table (MODEL_PROFILES is enough), a crawler for model
releases (a quarterly manual "model watch" using `model-landscape-*.md` is enough), LoRA
training (only after the arena shows reference-based consistency fails), Remotion, a hybrid
decision engine class, a dashboard for the arena (Markdown report + blind HTML page).
