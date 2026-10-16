# Content generation v2

Start with `target-architecture.md`, then `roadmap.md`.

| Document | Covers (brief section) |
|---|---|
| `current-state.md` | audit of reels, voice, models, benches, Jev, QA (7); slides are in `docs/creative-engine/current-state.md` |
| `target-architecture.md` | pipeline, contracts (CreativePlan, ShotSpec, LayoutSpec, QualityState), product router, tiers, recovery (6, 26-38, 85-99) |
| `model-landscape-visual.md` | image, edit, segmentation, upscale, I2V, depth, embeddings (8-9, 22, 39-40, 45, 69) |
| `model-landscape-text-audio.md` | LLM, VLM, TTS, ASR, alignment, audio QA, Jev (8-9, 43, 46, 54, 58-60) |
| `model-licensing.md` | licence matrix and hard gate (10) |
| `model-arena.md` | registry, arena, benchmark methodology, pairwise judging, Pareto, promotion, Jev shadow (13-21, 48-53) |
| `repository-review.md` | external repositories and adoptable ideas (76-84) |
| `roadmap.md` | phases, ordered tasks, risks (118, 128-129) |
| `experiments.md` | first experiments E1-E4 (119-122) |
| `results/` | measured arena runs (TTS, ASR, copy LLM so far) |

Consolidated on purpose: the brief listed 27 files; the topics above cover them without
duplicating `docs/creative-engine/` (layout, design tokens, product fidelity already live there).
`reference-quality.md` is not written: no frontier/ChatGPT reels are stored in the repository
(`current-state.md` 10). It needs the owner to export a few old reels into a git-ignored folder.
