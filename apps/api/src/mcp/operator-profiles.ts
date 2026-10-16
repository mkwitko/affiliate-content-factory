import { TOOL_RISK } from "./tool-risk.js";

/**
 * Tool allowlists for external autonomous operators (any MCP agent runtime). Each profile is a
 * subset of read and safe_write tools; approval_required and restricted tools are never listed,
 * so an agent cannot approve, publish, change policy or credentials even if its runtime or a
 * gateway would allow it. `submit_affiliate_links` stays human-owned: the person who generated
 * the Mercado Livre links submits them. Money Maker authorization and OAuth scopes still apply.
 */
export const OPERATOR_PROFILE_IDS = [
  "affiliate_scout",
  "media_strategist",
  "content_producer",
  "operations_supervisor",
] as const;
export type OperatorProfileId = (typeof OPERATOR_PROFILE_IDS)[number];

/** Tools no operator profile may list, whatever their risk class. */
export const HUMAN_OWNED_TOOLS: ReadonlySet<string> = new Set(["submit_affiliate_links"]);

/** OAuth scopes an operator connection requests: never content:approve or publish:write. */
export const OPERATOR_OAUTH_SCOPES = ["workspace:read", "content:read", "content:write"] as const;

const COMMON = [
  "get_profile",
  "list_workspaces",
  "get_workspace",
  "get_setup_status",
  "skills_list",
  "skills_get",
  "get_autonomy_status",
  "list_human_actions",
  "list_niches",
  "get_niche_context",
  "get_brand_context",
] as const;

export const OPERATOR_PROFILES: Readonly<Record<OperatorProfileId, readonly string[]>> =
  Object.freeze({
    affiliate_scout: [
      ...COMMON,
      "list_affiliate_link_queue",
      "list_product_candidates",
      "search_mercado_livre_products",
      "read_mercado_livre_buyer_voice",
      "discover_market_radar",
      "research_trends",
      "analyze_offer_price_history",
      "build_opportunity_brief",
      "list_offers",
      "get_offer",
      "check_offer_status",
      "list_learnings",
      "get_performance_summary",
    ],
    media_strategist: [
      ...COMMON,
      "list_channels",
      "get_channel_context",
      "list_episode_ideas",
      "create_episode_ideas",
      "record_episode_packaging",
      "create_episode_plan",
      "search_youtube_sources",
      "inspect_youtube_source",
      "inspect_source_transcript",
      "import_niche_research",
      "research_trends",
      "list_continuity_facts",
      "record_continuity_facts",
      "create_content_item",
      "create_content_script",
      "get_content_script",
      "get_generation_context",
      "list_recent_owned_long_forms",
      "list_learnings",
      "get_performance_summary",
    ],
    // Affiliate packages only (owner mission 2026-10-14). The desktop model has a 16k window and
    // 44 tool schemas alone took 17.5k tokens, so long-form, owned-clip and storyboard tools stay
    // out until a media niche needs this agent.
    content_producer: [
      ...COMMON,
      "run_autonomy_cycle",
      "list_pending_content",
      "preview_content",
      "get_offer",
      "list_channels",
      "get_channel_context",
      "get_generation_context",
      "get_story_kit",
      "list_assets",
      "create_content_item",
      "create_content_variant",
      "build_post_creatives",
      "edit_creative_copy",
      "create_story_assets",
      "create_creative_brief",
      "request_scene_direction",
      "render_reel",
      "get_reel_render",
    ],
    operations_supervisor: [
      ...COMMON,
      "list_pending_content",
      "preview_content",
      "get_publication_status",
      "list_home_worker_tokens",
      "list_assets",
      "get_reel_render",
      "get_long_form_render",
      "get_automation_policy",
      "get_research_policy",
      "get_attribution_summary",
      "get_performance_summary",
    ],
  });

/** Problems with a profile: unknown tools, risky tools or human-owned tools. Empty when valid. */
export const operatorProfileProblems = (id: OperatorProfileId): readonly string[] =>
  OPERATOR_PROFILES[id].flatMap((tool) => {
    const risk = TOOL_RISK[tool];
    if (!risk) return [`unknown_tool:${tool}`];
    if (risk !== "read" && risk !== "safe_write") return [`risky_tool:${tool}`];
    if (HUMAN_OWNED_TOOLS.has(tool)) return [`human_owned_tool:${tool}`];
    return [];
  });

/**
 * The Hermes `mcp_servers` entry for one profile (YAML text). Only the URL and the allowlist:
 * OAuth tokens stay in the runtime's own token store, never in this file.
 */
export const hermesMcpConfig = (id: OperatorProfileId, mcpUrl: string): string => {
  const url = new URL(mcpUrl);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    throw new Error("operator_mcp_url_not_https");
  const problems = operatorProfileProblems(id);
  if (problems.length) throw new Error(`operator_profile_invalid:${problems.join(",")}`);
  const tools = [...new Set(OPERATOR_PROFILES[id])].sort();
  return [
    "mcp_servers:",
    "  money_maker:",
    `    url: "${url.toString()}"`,
    "    auth: oauth",
    // Ask only for the operator scopes: Hermes otherwise requests everything the server
    // advertises (content:approve, publish:write), which would drop one governance layer.
    // The agents' first-party Auth0 client: Auth0 issues it only the operator scopes, whatever is
    // requested. Id and secret come from the agent home's .env, never from this file.
    "    oauth:",
    '      client_id: "${MM_AGENTS_OAUTH_CLIENT_ID}"',
    '      client_secret: "${MM_AGENTS_OAUTH_CLIENT_SECRET}"',
    "      redirect_port: 27890",
    `      scope: "${[...OPERATOR_OAUTH_SCOPES, "offline_access"].join(" ")}"`,
    "    tools:",
    "      include:",
    ...tools.map((tool) => `        - ${tool}`),
    "",
  ].join("\n");
};
