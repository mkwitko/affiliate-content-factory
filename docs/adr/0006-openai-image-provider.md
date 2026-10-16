# ADR 0006: OpenAI image generation

Status: superseded by [ADR 0009](0009-deterministic-creative-pipeline.md) on 2026-09-25.

Image generation is an explicit, billable MCP write. The service reserves an estimated cost before calling OpenAI, records unknown usage as unresolved, hashes verified bytes, and only exposes active workspace assets after media validation. Public URL imports require HTTPS, public destinations, size and MIME limits, and operator-supplied license metadata.
