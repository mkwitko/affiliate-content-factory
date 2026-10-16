# Model licence matrix

Date: 2026-10-06. Sources: `model-landscape-visual.md`, `model-landscape-text-audio.md` (each
row there cites the card). Hard gate: only `commercial_allowed` in `MODEL_PROFILES` can run in a
production path or win a promotion. `unknown` may run in a benchmark only (`arena: true`).
Licence of the WEIGHTS counts, not the code. Re-read the card before promotion.

| Model | Weights licence | Class | Registry | Use |
|---|---|---|---|---|
| FLUX.2 Klein 4B | Apache-2.0 | OPEN_COMMERCIAL | `local:flux-2-klein-4b` enabled | image champion |
| FLUX.2 Klein 9B, FLUX Krea | FLUX non-commercial | NON_COMMERCIAL | not registered | never |
| Z-Image-Turbo | Apache-2.0 | OPEN_COMMERCIAL | `local:z-image-turbo` enabled | plates |
| Mage-Flow-Edit-4B-Turbo | MIT on Comfy-Org repack; official card gated | UNKNOWN until read | `local:mage-flow-edit-4b-turbo` disabled, `unknown` | arena only |
| LongCat-Image-Edit-Turbo | Apache-2.0 | OPEN_COMMERCIAL | `local:longcat-image-edit-turbo` disabled | arena challenger |
| Qwen-Image-2.1 | Qwen Research License | RESEARCH_ONLY | `research_only` | never |
| Qwen-Image-Edit-2511 | Apache-2.0 | OPEN_COMMERCIAL | not registered | remote quality ceiling only (20B) |
| Boogu Edit-Turbo | Apache-2.0 (secondary source) | UNKNOWN | not registered | read card first |
| HunyuanVideo 1.5 | Tencent licence, territory exclusions | COMMERCIAL_WITH_CONDITIONS (excludes EU/UK/KR) | not registered | rejected |
| Wan2.2-TI2V-5B | Apache-2.0 | OPEN_COMMERCIAL | `local:wan2.2-ti2v-5b` disabled | I2V experiment |
| LTX-2.x | revenue cap | COMMERCIAL_WITH_CONDITIONS | not registered | remote only |
| BiRefNet | MIT | OPEN_COMMERCIAL | `local:birefnet` (segmentation) | cutout |
| BEN2 Base | MIT (Base only) | OPEN_COMMERCIAL | `local:ben2-base` disabled | arena challenger |
| RMBG-2.0 | CC BY-NC 4.0 | NON_COMMERCIAL | not registered | never |
| SAM 3 | SAM License (no military use) | COMMERCIAL_WITH_CONDITIONS | not registered | only if text-prompted masks are needed |
| Real-ESRGAN ncnn | BSD-3 / MIT | OPEN_COMMERCIAL | `local:realesrgan-ncnn-vulkan` | upscale champion |
| Real-CUGAN ncnn | MIT code, weights unread | UNKNOWN | `local:realcugan-ncnn-vulkan` disabled, `unknown` | arena only |
| 4x-UltraSharp | CC BY-NC-SA | NON_COMMERCIAL | not registered | never |
| Depth Anything 3 Small/Base, V2 Small | Apache-2.0 | OPEN_COMMERCIAL | not registered (motion phase) | 2.5D |
| Depth Anything V2 Base/Large, DA3 Large | CC BY-NC | NON_COMMERCIAL | not registered | never |
| Qwen3.5-4B / 9B | Apache-2.0 | OPEN_COMMERCIAL | enabled (scene_director) | LLM control |
| Qwen3.8-9B-Distill (empero-ai) | Apache-2.0 tag; training data unknown | COMMERCIAL_WITH_CONDITIONS (provenance risk) | disabled | director baseline; keep official Qwen3.5-9B as control |
| Gemma 4 E4B | Apache-2.0 per registry; re-read card | OPEN_COMMERCIAL | enabled | challenger |
| Ternary-Bonsai | Apache-2.0 | OPEN_COMMERCIAL | registered | RUNTIME_BLOCKED on AMD Vulkan (fork has no Vulkan) |
| Qwen3-VL 2B/4B/8B | Apache-2.0 | OPEN_COMMERCIAL | enabled | VLM champion 4B |
| Moondream 3 | BSL | COMMERCIAL_WITH_CONDITIONS + CUDA | not registered | rejected |
| Kokoro-82M | Apache-2.0 | OPEN_COMMERCIAL | enabled | TTS champion |
| Chatterbox Multilingual | MIT (Perth watermark in output) | OPEN_COMMERCIAL | disabled | TTS challenger |
| Qwen3-TTS | Apache-2.0 | OPEN_COMMERCIAL | disabled | TTS challenger |
| XTTS-v2 | Coqui CPML | NON_COMMERCIAL | not registered | never |
| F5-TTS pt-BR finetunes | CC BY-NC | NON_COMMERCIAL | not registered | never |
| whisper large-v3-turbo | MIT | OPEN_COMMERCIAL | not registered (ASR phase) | ASR baseline |
| Qwen3-ASR 1.7B, Qwen3-ForcedAligner 0.6B | Apache-2.0 | OPEN_COMMERCIAL | not registered | ASR challenger |
| MMS forced aligner | CC BY-NC | NON_COMMERCIAL | not registered | never |
| Jev (TypeSafe) | hosted API, terms unread | UNKNOWN (data terms) | n/a | shadow only until AUP/data terms are read |

Owner action: read the official microsoft/Mage-Flow card (gated) before any promotion; read Jev
data terms before sending more than minimal state.
