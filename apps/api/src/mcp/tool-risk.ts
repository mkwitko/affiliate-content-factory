/**
 * Governance risk class of every MCP tool, published as `_meta` so a gateway
 * (for example Paperclip) can map it to allow / require_approval / block
 * without guessing. MCP annotations are untrusted hints; this table is the
 * authoritative declaration and is checked against the registered tools in tests.
 *
 * - read: reads state or computes a result without persisting anything.
 * - safe_write: bounded, repeatable domain writes (drafts, imports, renders,
 *   notes, queue items). They never publish, approve, spend on a provider
 *   without a policy, or change who can do what.
 * - approval_required: a human decision in the domain (approve, reject,
 *   cancel, publish, rights, activation, brand and niche definition, publishing
 *   channels). Registered with destructiveHint so clients confirm first.
 * - restricted: credentials, invitations, tokens, provider connections and
 *   automation/research policies. Gateways should block these by default.
 */
export type ToolRisk = "read" | "safe_write" | "approval_required" | "restricted";

/** Reverse-DNS-style prefix required by the MCP `_meta` key rules. */
export const RISK_META_KEY = "moneymaker.example.com/risk";

const group = (risk: ToolRisk, names: readonly string[]): [string, ToolRisk][] =>
  names.map((name) => [name, risk]);

export const TOOL_RISK: Readonly<Record<string, ToolRisk>> = Object.freeze(
  Object.fromEntries([
    ...group("read", [
      "get_generation_budget",
      "get_generation_routes",
      "analyze_offer_price_history",
      "build_opportunity_brief",
      "check_offer_status",
      "create_creative_brief",
      "create_episode_plan",
      "discover_market_radar",
      "get_attribution_summary",
      "get_autonomy_status",
      "get_automation_policy",
      "get_brand_context",
      "get_channel_context",
      "get_content_script",
      "get_generation_context",
      "get_long_form_render",
      "get_long_form_timing",
      "get_niche_context",
      "get_offer",
      "get_owned_clip_render",
      "get_performance_summary",
      "get_profile",
      "get_publication_status",
      "get_reel_render",
      "get_research_policy",
      "get_setup_status",
      "get_story_kit",
      "get_tiktok_shop_status",
      "get_workspace",
      "inspect_source_transcript",
      "inspect_youtube_source",
      "list_affiliate_link_queue",
      "list_assets",
      "list_channels",
      "list_continuity_facts",
      "list_episode_ideas",
      "list_home_worker_tokens",
      "list_human_actions",
      "list_learnings",
      "list_niches",
      "list_offers",
      "list_pending_content",
      "list_product_candidates",
      "list_provider_connections",
      "list_recent_owned_long_forms",
      "list_workspaces",
      "preview_content",
      "read_mercado_livre_buyer_voice",
      "refine_owned_clip_boundaries",
      "refine_owned_clip_time_range",
      "research_trends",
      "search_mercado_livre_products",
      "search_youtube_sources",
      "skills_get",
      "skills_list",
      "suggest_owned_clip_candidates",
    ]),
    ...group("safe_write", [
      "add_offer_evidence",
      "build_post_creatives",
      "create_content_item",
      "create_content_script",
      "create_content_variant",
      "create_episode_ideas",
      "create_niche",
      "create_offer",
      "create_story_assets",
      "create_video_storyboard",
      "edit_creative_copy",
      "import_asset_from_file",
      "import_asset_from_url",
      "import_mercado_livre_offer",
      "import_niche_research",
      "import_tiktok_shop_product",
      "preview_video_storyboard",
      "record_continuity_facts",
      "record_episode_packaging",
      "record_owned_clip_candidates",
      "render_long_form",
      "render_owned_clip",
      "render_reel",
      "request_scene_direction",
      "request_storyboard_scenes",
      "retry_failed_job",
      "run_autonomy_cycle",
      "submit_affiliate_links",
      "sync_canva_design",
    ]),
    ...group("approval_required", [
      "activate_offer",
      "approve_content",
      "approve_content_script",
      "cancel_content",
      "create_channel",
      "decide_episode_idea",
      "publish_content",
      "reconcile_publication",
      "record_editorial_review",
      "record_manual_publication",
      "record_tiktok_shop_status",
      "reject_content",
      "review_home_worker_asset",
      "set_asset_rights",
      "update_brand_context",
      "update_channel_context",
      "update_niche",
      "update_niche_context",
    ]),
    ...group("restricted", [
      "connect_cloud_provider",
      "set_generation_route",
      "set_channel_niche",
      "set_generation_budget",
      "create_automation_policy",
      "create_home_worker_token",
      "create_invitation",
      "create_provider_connection",
      "create_research_policy",
      "pause_automation_policy",
      "pause_research_policy",
      "revoke_automation_policy",
      "revoke_home_worker_token",
      "revoke_provider_connection",
      "revoke_research_policy",
    ]),
  ]) as Record<string, ToolRisk>,
);

/** Gateways confirm before running these, so clients see them as destructive. */
export const isHighRisk = (risk: ToolRisk): boolean =>
  risk === "approval_required" || risk === "restricted";

export const riskOf = (toolName: string): ToolRisk => {
  const risk = TOOL_RISK[toolName];
  if (!risk) throw new Error(`MCP tool ${toolName} has no entry in TOOL_RISK`);
  return risk;
};
