# Paperclip contract

Money Maker is a governed MCP service. A gateway such as Paperclip (paperclipai/paperclip, MIT)
sits between agents and Money Maker, catalogs the tools and applies policy. Money Maker keeps
the domain: facts, evidence, claims, approval, publication policy, attribution and revenue.
The gateway keeps agent operations.

## Connecting

Add the existing MCP endpoint as a remote HTTP upstream and authenticate with OAuth (the same
flow ChatGPT and Claude use). No new endpoint, key type or scope exists for gateways.

## Risk metadata

Every tool carries `_meta["moneymaker.example.com/risk"]` with one of four classes. MCP
annotations are hints and untrusted; this key is Money Maker's own declaration, and the
source of truth is `TOOL_RISK` in `apps/api/src/mcp/tool-risk.ts`. A test fails if a tool is
missing or if the tables below drift from it.

| Class | Meaning | Paperclip policy |
| --- | --- | --- |
| read | Reads or computes, persists nothing | allow |
| safe_write | Bounded, repeatable domain write (drafts, imports, renders, notes, queue items). Never publishes, approves, spends without policy or changes permissions | allow (or rate_limit) |
| approval_required | A human decision: approve, reject, cancel, publish, rights, activation, brand/niche definition, publishing channels | require_approval |
| restricted | Credentials, invitations, tokens, provider connections, automation and research policies | block |

`approval_required` and `restricted` tools also set `destructiveHint: true`, so Paperclip
quarantines them on first sight and ChatGPT asks for confirmation before approve or publish
calls. That prompt is intended. Read tools keep `readOnlyHint: true` and are never destructive.

Classification calls worth knowing: `reconcile_publication`, `record_manual_publication` and
`record_tiktok_shop_status` write facts about the outside world, so a person confirms them.
`update_brand_context`, `update_niche`, `update_niche_context`, `update_channel_context` and
`create_channel` define what the factory may say and where it posts. `pause_*` policy tools are
restricted too: policy changes belong to the owner even when they only reduce autonomy.
`sync_canva_design` and the `import_*` tools are safe_write because imported assets stay
unusable until rights are set (`set_asset_rights` is approval_required). `run_autonomy_cycle`
is safe_write because the cycle never approves, publishes or links.

## READ (allow)

| Tool | Risk |
| --- | --- |
| `analyze_offer_price_history` | read |
| `build_opportunity_brief` | read |
| `check_offer_status` | read |
| `create_creative_brief` | read |
| `create_episode_plan` | read |
| `discover_market_radar` | read |
| `get_attribution_summary` | read |
| `get_automation_policy` | read |
| `get_autonomy_status` | read |
| `get_brand_context` | read |
| `get_channel_context` | read |
| `get_content_script` | read |
| `get_generation_budget` | read |
| `get_generation_routes` | read |
| `get_generation_context` | read |
| `get_long_form_render` | read |
| `get_long_form_timing` | read |
| `get_niche_context` | read |
| `get_offer` | read |
| `get_owned_clip_render` | read |
| `get_performance_summary` | read |
| `get_profile` | read |
| `get_publication_status` | read |
| `get_reel_render` | read |
| `get_research_policy` | read |
| `get_setup_status` | read |
| `get_story_kit` | read |
| `get_tiktok_shop_status` | read |
| `get_workspace` | read |
| `inspect_source_transcript` | read |
| `inspect_youtube_source` | read |
| `list_affiliate_link_queue` | read |
| `list_assets` | read |
| `list_channels` | read |
| `list_continuity_facts` | read |
| `list_episode_ideas` | read |
| `list_home_worker_tokens` | read |
| `list_human_actions` | read |
| `list_learnings` | read |
| `list_niches` | read |
| `list_offers` | read |
| `list_pending_content` | read |
| `list_product_candidates` | read |
| `list_provider_connections` | read |
| `list_recent_owned_long_forms` | read |
| `list_workspaces` | read |
| `preview_content` | read |
| `read_mercado_livre_buyer_voice` | read |
| `refine_owned_clip_boundaries` | read |
| `refine_owned_clip_time_range` | read |
| `research_trends` | read |
| `search_mercado_livre_products` | read |
| `search_youtube_sources` | read |
| `skills_get` | read |
| `skills_list` | read |
| `suggest_owned_clip_candidates` | read |

## ACT (safe_write: allow or rate_limit)

| Tool | Risk |
| --- | --- |
| `add_offer_evidence` | safe_write |
| `build_post_creatives` | safe_write |
| `create_content_item` | safe_write |
| `create_content_script` | safe_write |
| `create_content_variant` | safe_write |
| `create_episode_ideas` | safe_write |
| `create_niche` | safe_write |
| `create_offer` | safe_write |
| `create_story_assets` | safe_write |
| `create_video_storyboard` | safe_write |
| `edit_creative_copy` | safe_write |
| `import_asset_from_file` | safe_write |
| `import_asset_from_url` | safe_write |
| `import_mercado_livre_offer` | safe_write |
| `import_niche_research` | safe_write |
| `import_tiktok_shop_product` | safe_write |
| `preview_video_storyboard` | safe_write |
| `record_continuity_facts` | safe_write |
| `record_episode_packaging` | safe_write |
| `record_owned_clip_candidates` | safe_write |
| `render_long_form` | safe_write |
| `render_owned_clip` | safe_write |
| `render_reel` | safe_write |
| `request_scene_direction` | safe_write |
| `request_storyboard_scenes` | safe_write |
| `retry_failed_job` | safe_write |
| `run_autonomy_cycle` | safe_write |
| `submit_affiliate_links` | safe_write |
| `sync_canva_design` | safe_write |

## HIGH RISK (approval_required: require_approval)

| Tool | Risk |
| --- | --- |
| `activate_offer` | approval_required |
| `approve_content_script` | approval_required |
| `approve_content` | approval_required |
| `cancel_content` | approval_required |
| `create_channel` | approval_required |
| `decide_episode_idea` | approval_required |
| `publish_content` | approval_required |
| `reconcile_publication` | approval_required |
| `record_editorial_review` | approval_required |
| `record_manual_publication` | approval_required |
| `record_tiktok_shop_status` | approval_required |
| `reject_content` | approval_required |
| `review_home_worker_asset` | approval_required |
| `set_asset_rights` | approval_required |
| `update_brand_context` | approval_required |
| `update_channel_context` | approval_required |
| `update_niche_context` | approval_required |
| `update_niche` | approval_required |

## HIGH RISK (restricted: block)

| Tool | Risk |
| --- | --- |
| `connect_cloud_provider` | restricted |
| `create_automation_policy` | restricted |
| `create_home_worker_token` | restricted |
| `create_invitation` | restricted |
| `create_provider_connection` | restricted |
| `create_research_policy` | restricted |
| `pause_automation_policy` | restricted |
| `pause_research_policy` | restricted |
| `revoke_automation_policy` | restricted |
| `revoke_home_worker_token` | restricted |
| `revoke_provider_connection` | restricted |
| `revoke_research_policy` | restricted |
| `set_generation_budget` | restricted |
| `set_generation_route` | restricted |
| `set_channel_niche` | restricted |

## Recommended operator loop

Follow `docs/operations/autonomous-operator.md`: `get_autonomy_status`, `run_autonomy_cycle`,
`list_human_actions`, then tell the person what waits.

## Overlap with Paperclip scheduling

The `AUTONOMY_ENABLED` worker loop and `get_autonomy_status` are domain-level: they keep Money
Maker supplied without any agent and stay. Where Paperclip is used, a routine can call
`run_autonomy_cycle` instead of enabling the loop. Both are safe together because the cycle
is idempotent.

## What Money Maker will not build

A generic task manager, org chart, agent heartbeat, budget tracker, scheduler or skills
marketplace. Paperclip owns those. Money Maker owns the domain rules behind the tools above.
