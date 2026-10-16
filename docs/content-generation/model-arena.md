# Model arena, benchmark methodology and Jev shadow mode

Date: 2026-10-06. Status: foundation implemented (`packages/core/src/arena/`,
`packages/core/src/decisions/shadow-metrics.ts`); suites not yet unified.

## 1. What already exists (reuse, do not rebuild)

| Piece | Where | Keeps |
|---|---|---|
| Model registry | `core/assets/model-policy.ts` `MODEL_PROFILES` | id, capability, runtime, weights licence, `licensePolicy`, `enabled`, quantization, hardware class |
| Licence gate | `mayUseModelCommercially`, `candidateRefusal` in each bench | research-only and unknown never run in a commercial path |
| Per-domain benches | `apps/worker/src/commands/{image,edit,copy,voice,video,vlm,fidelity}-bench.ts`, `render-bench*` | rows with wall time, validity, errors; `promoted: false` always |
| Blind listening page | `voice-bench.ts` `buildListeningPage` (seeded shuffle, reveal) | the pattern for blind human labels |
| Decision provider + shadow | `core/decisions/jev-shadow.ts` (`DecisionProvider`, `evaluateJevShadow`), `hook-pick.ts` | Jev answers never change the accepted choice |
| Desktop runner | `scripts/local-ai/desktop.sh` | one model at a time on the RX 6650 XT |

The registry is `MODEL_PROFILES`. There is no second registry. Licence classes from the brief map
onto `licensePolicy`: OPEN_COMMERCIAL and COMMERCIAL_WITH_CONDITIONS (conditions met) =
`commercial_allowed`; NON_COMMERCIAL and RESEARCH_ONLY = `research_only`; UNKNOWN = `unknown`;
conditions not met = `blocked`. Only `commercial_allowed` can run in production or win a
promotion.

## 2. What the arena adds (implemented)

| Module | Function | Purpose |
|---|---|---|
| `arena/ranking.ts` | `reconcileJudgments` | pairs a blind judgment with its swapped-order twin; disagreement = `positionBias`, scored as a tie |
| | `bradleyTerry` | MM-fitted Bradley-Terry over outcomes, ties = half win, one virtual win + loss vs an anchor (keeps sweeps finite, shrinks small samples); score on an Elo-like scale |
| | `headToHead` | challenger win rate vs the champion |
| `arena/promotion.ts` | `ARENA_STAGES` | smoke 6 cases x 1 seed, qualification 18 x 2, full 30 x 3 |
| | `paretoFrontier` | non-dominated candidates over any objectives (quality, fidelity, latency, VRAM, failure rate) |
| | `proposePromotion` | `promote` / `promote_quality_tier` / `keep` / `reject` with reasons; never mutates policy |
| `decisions/shadow-metrics.ts` | `shadowAgreement` | advisor vs rules vs human: agreement, false accept, false reject, reject precision/recall, calibration error |

### Why Bradley-Terry and not Elo

Elo depends on the order games are played and needs a K factor. Our judgments are a batch, so a
maximum-likelihood fit is order-free and uses all data. MM (Hunter 2004) needs no step size and
converges for connected comparison graphs; the anchor prior handles the disconnected or
unbeaten case. Ties as half wins is the Rao-Kupper simplification; good enough until tie rates
are high.

### Promotion rule (`ARENA_PROMOTION`)

1. Reject: weights not `commercial_allowed`; measured peak VRAM > 7,680 MB.
2. Keep: any stage not `pass`; any critical regression; < 18 comparisons; head-to-head win rate
   < 0.60; failure rate higher than the champion.
3. Promote as QUALITY tier: wins but p95 latency > 1.5x the champion (champion stays FAST).
4. Otherwise promote. The proposal goes to the owner; model policy changes by commit.

Thresholds are starting values, recorded in code, tuned against owner decisions.

## 3. Tasks, not models

A champion is per task and tier. Initial task ids (image tasks answer the first experiment):

| Task | Today's champion | Note |
|---|---|---|
| `image.character_scene` | `local:flux-2-klein-4b` | owner-approved 2026-10-06 |
| `image.character_product` | `local:flux-2-klein-4b` + fidelity gate | Phase C gate |
| `image.transparent_product` | none (real composite) | generative product not allowed by default |
| `image.packaging` | none (real composite) | text/logo on pack |
| `image.product_hero` | real product photo + generated background | |
| `image.negative_space` | `local:flux-2-klein-4b` | composition clause |
| `vision.product_verification` | `local:qwen3-vl-4b` | 6/6 + 12/12 on 2026-10-06 |
| `llm.offer_copy` | home-worker copywriter model | see current-state.md |
| `tts.ptbr_narration` | `local:kokoro` | |
| `upscale.illustration` | `local:realesrgan-ncnn-vulkan` | `realesr-animevideov3` x2 |
| `segmentation.product` | local white-bg cutout; `local:birefnet` optional | |

Tiers: DRAFT (cheap, composition only), FAST (daily default), QUALITY (high expected ROI),
RECOVERY (after a reasoned failure). The routing table becomes code (`arena/tasks.ts`) when the
first production path consults it; until then this table is the record.

## 4. Benchmark methodology

- **Stages.** Smoke catches load/OOM/crash/invalid output. Qualification eliminates: a challenger
  whose head-to-head win rate is < 0.35 after qualification stops there. Full decides.
- **Dataset.** `fixtures/arena/` (to create): 30 Example Shop products (10 Casa, 10 Beleza, 10
  Tech) with listing photos, verified facts and a hardness tag (transparent, reflective, screen,
  cable, packaging text, small, large, multi-part, rigid, soft, held, in use, hero). Each case
  names character (Carla, Bia, Rafa), shot type and a layout with negative-space region.
  Fixture images are listing photos already used in production; no personal data.
- **Model x prompt.** Each case runs per prompt strategy (`minimal`, `detailed`,
  `layout_aware`, `reference_explicit`); `promptVersion` is part of the candidate id.
- **Run record (one row per output).** benchmarkVersion, caseId, model, modelVersion,
  runtimeVersion, quantization, promptVersion, seed, resolution, steps, cfg, sampler,
  input/reference hashes, startedAt, durationMs, peakVramMb, peakRamMb, outputHash, success,
  error, quality metrics. Today's bench rows already carry most of these; missing are hashes,
  promptVersion, runtimeVersion and memory peaks (filled by the desktop wrapper).
- **Judging.** Automatic first: deterministic checks (decode, size, luma), product fidelity
  (`in-scene-fidelity.ts`), VLM pairwise judge with both orders. Human pairwise labels
  (A better / B better / tie / reject both + reasons) on a sample and on every close call. Final
  promotion needs human labels; VLM-only rankings are advisory.
- **Reporting.** `reports/ai-arena/<date>/<suite>/` (git-ignored outputs; the Markdown summary
  is committed under `docs/content-generation/results/`): ranking, Pareto set, pairwise matrix,
  failures, latency, memory, licence, proposal.
- **Honesty.** A model that could not run is `NOT_TESTED`, `OOM`, `RUNTIME_BLOCKED` or
  `LICENSE_BLOCKED`. No score is copied from a model card.
- **Resources.** One heavy model loaded at a time; the runner stops the runtime before the next
  candidate (`desktop.sh` already serialises).

## 5. Jev shadow mode

Exists: `DecisionProvider` interface, closed question set (`JEV_QUESTIONS`), `evaluateJevShadow`
(records `ai.decision.shadow_recorded`, never changes the choice), `pickStrongestHook` (the one
place Jev decides, behind `JEV_ENABLED`, original hook always a candidate).

Adds now: `shadowAgreement` to score any advisor against human decisions.

Next (task T5 in `roadmap.md`): a `QualityState` built from data already computed (prepublish
score, fidelity, render QA, copy validation), shadow questions `should_regenerate`,
`should_escalate`, `primary_problem`, `next_action`, and a join of shadow records with the
owner's approve/reject events to feed `shadowAgreement`. Hard blockers (price mismatch,
unverified claim, product wrong, licence unknown, text over face, safe zone, missing `#publi`,
invalid media) are deterministic and Jev cannot release them. A decision type is promoted from
shadow only when false accepts are 0 over at least 50 labelled cases and agreement beats rules.

## 6. Running every candidate automatically (`pnpm ai:arena:run`)

The catalog (`core/arena/catalog.ts`, checked on Hugging Face 2026-10-06) lists every candidate
per task with its files, sizes and launch settings; `MODEL_PROFILES` stays the licence gate.

```bash
pnpm ai:arena:run tts.ptbr                     # this machine (CPU): tts.ptbr, asr.ptbr, llm.offer_copy
pnpm ai:arena:run llm.offer_copy --stage=qualification
bash scripts/local-ai/desktop.sh arena-tudo    # desktop GPU: vision, images, plates, upscale, llm, video
ARENA_STAGE=full bash scripts/local-ai/desktop.sh arena-tudo
```

For each candidate, one at a time: licence check, disk check, resumable download, start the
runtime (audio.cpp / llama-server locally, sd-server / llama-server on the desktop through
`desktop.sh servir`), run the suite, stop, write `results.json` (checkpoint: a rerun continues).
On the CPU target a measured challenger's weights are deleted afterwards; champions stay because
they are also the judges. A model that cannot run is `NOT_TESTED`, `OOM`, `RUNTIME_BLOCKED` or
`LICENSE_BLOCKED`, never a score.

| Task | Automatic QA (quantitative) | Judge | Primary metric and gates |
|---|---|---|---|
| `llm.offer_copy` | production copy loop + validator (schema, verified numbers only, no invented shipping/discount, limits) on 9 products | none | passRate; no runtime errors |
| `vision.product_verification` | right product vs swapped product on the approved scenes | none | accuracy; false accept = 0, parse failures <= 5 % |
| `image.character_product` | decode + size, production product-fidelity gate (VLM + colour) on each output | Qwen3-VL 4B | productFidelity; every image valid; + blind pairwise win rate vs Klein |
| `image.scene_plate` | decode + size, luma, VLM: no text, no person, no featured product | Qwen3-VL 4B | cleanPlate; every image valid |
| `tts.ptbr` | level, clipping, edge silence, speaking rate per line; ASR round trip | Qwen3-ASR 1.7B | CER; no failures, no clipping, CER <= 8 % |
| `asr.ptbr` | WER on known speech (Kokoro, 2 voices, the pt-BR corpus) | none | WER; no failures |
| `upscale.illustration` | halve an approved scene, upscale, SSIM/PSNR vs the original | none | SSIM |
| `video.i2v` | decode, frames, motion; product fidelity on the last frame | Qwen3-VL 4B | productFidelity; every clip valid |

Outputs per run in `reports/ai-arena/<date>/<task>-<stage>/`: `leaderboard.md/json` (ranking,
gates, per-case win rate against the champion, Pareto set, promotion proposals), the candidates'
files in neutral folders `c01`, `c02`... and, for images, audio and video, `judge.html`: the
owner's blind A/B page. Saving its download as `judgments-human.json` and running
`node apps/worker/dist/commands/arena.js report <dir>` adds the human Bradley-Terry ranking;
with 6 or more human comparisons the promotion proposal follows the human labels.

## 7. Level 2: real products and finished posts

- **Real-product set** (`core/arena/fixtures/real-products.ts`, captured 2026-10-07): 26 Mercado
  Livre products (10 casa, 9 beleza, 7 tech) with the listing photo and the price/shipping facts
  of that day, tagged with the hard cases (transparent, reflective, cable, packaging text, part
  counts). Five come from the workspace's active offers (verified snapshots). Benchmark only.
- `--dataset=real` runs the copy arena on their facts and the image arena on their listing photos
  (scene prompt from the listing title, production prompt style).
- **End to end** (`arena-e2e`, desktop step `bash scripts/local-ai/desktop.sh arena-e2e`): the
  same products become finished posts and narrated Reels through pipeline A (production: copy
  distill, Klein, Reel v1) and pipeline B (challenger, chosen by `E2E_COPY_B`, `E2E_IMAGE_B`,
  `E2E_REEL_B`). QA: copy validator, product fidelity of every scene (Qwen3-VL), render QA of
  every Reel. Output `e2e-summary.md` plus two blind pages: `judge.html` (whole Reels) and
  `judge-covers.html` (cover slides).
