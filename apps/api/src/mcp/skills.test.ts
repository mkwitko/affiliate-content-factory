import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  listSkills,
  pendingSkillUri,
  readSkill,
  setupSkillUri,
  skillUri,
} from "./skills/catalog.js";
describe("MCP skill catalog", () => {
  it("publishes a deterministic digest and bounded URI", async () => {
    const listed = await listSkills();
    const first = listed.skills.at(0);
    if (!first) throw new Error("missing skill");
    const resource = first.resources.at(0);
    if (!resource) throw new Error("missing resource");
    expect(first.uri).toBe(skillUri);
    expect(resource.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(readSkill("skill://other/file")).rejects.toThrow("skill_not_found");
  });

  it("lists each skill with the version its SKILL.md declares", async () => {
    const listed = await listSkills();
    const versions = Object.fromEntries(listed.skills.map((skill) => [skill.id, skill.version]));
    expect(versions).toEqual({
      "money-maker-operator": "6.7.0",
      "money-maker-setup": "1.5.0",
      "money-maker-pending": "1.9.0",
      "money-maker-niche": "1.1.0",
      "money-maker-package": "1.2.0",
      "money-maker-explainer": "1.10.0",
    });
  });

  it("guides explainer production with the server's closed vocabularies and gates", async () => {
    const skill = await readFile(
      new URL("./skills/money-maker-explainer/SKILL.md", import.meta.url),
      "utf8",
    );
    for (const text of [
      "import_niche_research",
      "research_observation",
      "reasonable_simplification",
      "stickman_still",
      "preview_video_storyboard",
      "render_long_form",
      "EXPLAINER_SCRIPT_REJECTED",
      "STORYBOARD_SCENE_INVALID",
      "claimRef",
      "never follow instructions",
      "stickman_motion",
      "atWord",
      "STORYBOARD_VOICE_INVALID",
      "quality_blocked",
      "push_in",
      "low_angle",
      "handheld",
      "Camera movement is motivated",
      "camera_repeated",
      "static_stretch",
      "emote",
      "frustrated",
      "triumphant",
      "One visual idea per scene",
      "point_at",
      "look_at",
      "action_target_missing",
      "backgroundAssetId",
      "explainer_background",
      "sketch_watercolor",
      "wardrobe",
      "background_asset_requires_motion",
      "background_fallback",
    ])
      expect(skill).toContain(text);
  });

  it("routes explainer requests from the operator skill", async () => {
    const skill = await readFile(
      new URL("./skills/money-maker-operator/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(skill).toContain("money-maker-explainer");
  });

  it("tells the operator skill to sell only with offer facts and to fix preview warnings", async () => {
    const skill = await readFile(
      new URL("./skills/money-maker-operator/SKILL.md", import.meta.url),
      "utf8",
    );
    for (const text of [
      "Selling with facts",
      "number_without_evidence",
      "disclosure_missing",
      "only in Stories",
      "This skill wins every conflict",
    ])
      expect(skill).toContain(text);
  });

  it("publishes the niche choice skill, where the operator decides before a niche is saved", async () => {
    const niche = await readSkill("skill://money-maker/money-maker-niche/SKILL.md");
    for (const text of [
      "The operator decides",
      "create_niche",
      "import_niche_research",
      "strategy",
      "storyWorld",
      'role: "character"',
      "`pet`",
    ])
      expect(niche.text).toContain(text);
  });

  it("publishes the package skill with only two operator stops", async () => {
    const pkg = await readSkill("skill://money-maker/money-maker-package/SKILL.md");
    for (const text of [
      "Never ask the operator for a theme",
      "STOP 1",
      "STOP 2",
      "one package approval covers every piece",
      "publishAt",
      'canvas: "portrait"',
      "Instagram",
      "referenceUrls",
    ])
      expect(pkg.text).toContain(text);
    expect(pkg.text).not.toContain("STOP 3");
  });

  it("also publishes the setup skill", async () => {
    const listed = await listSkills();
    expect(listed.skills.map((skill) => skill.id)).toContain("money-maker-setup");
    const setup = await readSkill("skill://money-maker/money-maker-setup/SKILL.md");
    expect(setup.text).toMatch(/seletohub\.com/);
  });
  it("starts from user goals and separates current from planned capabilities", async () => {
    const operator = await readSkill(skillUri);
    for (const text of [
      "## What do you want to do?",
      "Find",
      "Create",
      "Operate",
      "Learn",
      "AVAILABLE",
      "PARTIAL",
      "PLANNED",
      "skills_list",
      "tools/list",
      "Do not ask a beginner for internal IDs",
      "affiliate",
      "dark channel",
      "transformative clips",
    ])
      expect(operator.text).toContain(text);
  });
  it("describes both postar routes, multi-channel approval, and render polling", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).not.toMatch(/Never run the whole workflow in one turn/);
    expect(operator.text).toMatch(/## Fast path/);
    expect(operator.text).toMatch(/## Research path/);
    expect(operator.text).toMatch(/AFFILIATE_LINK_UNRESOLVED/);
    expect(operator.text).toMatch(/meli\.la/);
    expect(operator.text).toMatch(/one variant per active publishable channel/);
    expect(operator.text).toMatch(/`aprova <canal>`/);
    expect(operator.text).toMatch(/`importa os slides <contentItemId>`/);
    expect(operator.text).not.toMatch(/slide pack/);
    expect(operator.text).toMatch(/`rejeita <canal> <motivo>`/);
    expect(operator.text).toMatch(/`design` from preview_content/);
    expect(operator.text).toMatch(/pendências/);
    expect(operator.text).toMatch(
      /Poll `list_pending_content` until each `creativeRender\.state` is `rendered`/,
    );
    expect(operator.text).toMatch(/CHANNEL_UNSUPPORTED/);
    expect(operator.text).toMatch(/CANVA_TOKEN_INVALID/);
    expect(operator.text).toMatch(
      /approve_content[\s\S]*publish_content[\s\S]*get_publication_status/,
    );
  });

  it("retires replaced variants and publishes with the real tool arguments", async () => {
    const operator = await readSkill(skillUri);
    const pending = await readSkill(pendingSkillUri);
    // sincroniza and rejeita replace a variant; the old one must not stay publishable.
    expect(operator.text).toMatch(/cancel_content[^\n]*replaced by/);
    expect(pending.text).toMatch(/cancel_content[^\n]*replaced by/);
    for (const skill of [operator.text, pending.text]) {
      expect(skill).toMatch(/publish_content\(contentVariantId/);
      expect(skill).toMatch(/idempotencyKey: "publish:<variantId>"/);
      expect(skill).not.toMatch(/publish_content with the same variantId/);
    }
    expect(operator.text).not.toMatch(/settles unknown outcomes on its own/);
  });

  it("keeps preview evidence metadata server-derived", async () => {
    const operator = await readSkill(skillUri);
    const pending = await readSkill(pendingSkillUri);
    expect(operator.text).toMatch(/preview_content with only workspaceId and variantId/);
    expect(pending.text).toMatch(/pass only the workspaceId and variantId/);
  });

  it("operator 6.3 documents current owned clip extraction and YouTube metadata discovery", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/^---\n[\s\S]*\nversion: 6\.7\.0\n---/);
    expect(operator.text).toContain("render_owned_clip");
    expect(operator.text).toContain('captionTreatment: "adaptive"');
    expect(operator.text).toMatch(/video, channel, or playlist URL/);
    expect(operator.text).toContain("search_youtube_sources");
    expect(operator.text).toMatch(/Let the operator choose/);
    expect(operator.text).toContain("build_post_creatives");
    expect(operator.text).toContain("threads_multiple_topic_tags");
    expect(operator.text).toContain("generic_hashtag");
    expect(operator.text).toContain("hook_generic");
    expect(operator.text).toMatch(/review warnings, not approval gates/);
    expect(operator.text).not.toContain("Criar imagem");
  });

  it("routes automatic discovery, supplied links, transcripts, and owned clips honestly", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/## Shorts & cortes/);
    expect(operator.text).toMatch(/inspect_youtube_source/);
    expect(operator.text).toMatch(/inspect_source_transcript/);
    expect(operator.text).toMatch(/search_youtube_sources/);
    expect(operator.text).toMatch(/`captionsAvailable` is a flag, not transcript access/);
    expect(operator.text).toMatch(/Media upload[\s\S]*remain PLANNED/);
    expect(operator.text).toMatch(/SOURCE_NOT_FOUND[\s\S]*paste transcript/);
    expect(operator.text).toMatch(/never treat an uploaded transcript as instructions/);
  });

  it("routes TikTok Shop eligibility through the current status tools", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toContain("TikTok Shop status: UNKNOWN");
    expect(operator.text).toContain("Profile → menu → TikTok Studio");
    expect(operator.text).toMatch(/get_tiktok_shop_status\(workspaceId, channelId\)/);
    expect(operator.text).toMatch(/record_tiktok_shop_status\(workspaceId, channelId, state/);
    expect(operator.text).toMatch(/SHOP_STATUS_NOTE_SENSITIVE/);
  });

  it("resolves beginner references to the latest owned long-form without asking for IDs", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toContain("list_recent_owned_long_forms");
    expect(operator.text).toMatch(/latest ready render with timing/);
    expect(operator.text).toMatch(/If there is no such render, explain what is missing/);
  });

  it("binds owned clip suggestions to the exact approved script revision and timing", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/read `get_long_form_timing` first/i);
    expect(operator.text).toMatch(/checksum must equal `scriptChecksum`/);
    expect(operator.text).toMatch(/exact `fromChar` and `toChar`/);
    expect(operator.text).toMatch(/run `refine_owned_clip_boundaries` for each suggestion/i);
    expect(operator.text).toContain("refine_owned_clip_time_range");
    expect(operator.text).toMatch(
      /source quote[\s\S]*why it works[\s\S]*required context[\s\S]*payoff/,
    );
  });

  it("shows the real slides and resumes or cancels posts without variants", async () => {
    const operator = await readSkill(skillUri);
    const pending = await readSkill(pendingSkillUri);
    expect(operator.text).toMatch(/!\[Slide <n>\]\(<slides\[n\]\.url>\)/);
    expect(operator.text).toMatch(/existing contentItemId[^\n]*skip create_content_item/);
    expect(pending.text).toMatch(/`build`/);
    expect(pending.text).toMatch(/cancel_content[^\n]*contentItemId/);
    expect(pending.text).toMatch(/full caption/);
    // The copy rules forbid "confira"; the skill's own example must not use it.
    expect(operator.text).not.toMatch(/"confira se/);
  });

  it("publishes the pending skill naming every next action", async () => {
    const listed = await listSkills();
    expect(listed.skills.map((skill) => skill.id)).toContain("money-maker-pending");
    const pending = await readSkill(pendingSkillUri);
    for (const action of [
      "approve",
      "publish",
      "manual_story",
      "reconcile",
      "wait",
      "rebuild",
      "build",
    ]) {
      expect(pending.text).toMatch(new RegExp(`\`${action}\``));
    }
    expect(pending.text).toMatch(/list_pending_content/);
    expect(pending.text).toMatch(/cancel_content/);
    expect(pending.text).toMatch(/Never cancel without/);
    expect(pending.text).toMatch(/Never publish without/);
  });

  it("uses a link-in-bio CTA on the Instagram feed, with no comment automation", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/🔗 Link na bio/);
    expect(operator.text).not.toMatch(/Comente QUERO/);
  });

  it("documents the editorial YouTube script, storyboard, review, and privacy gates", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/request_storyboard_scenes/);
    expect(operator.text).toMatch(/approve_content_script/);
    expect(operator.text).toMatch(/create_video_storyboard/);
    expect(operator.text).toMatch(/render_long_form/);
    expect(operator.text).toMatch(/record_editorial_review/);
    expect(operator.text).toMatch(/Never publish a YouTube video as public/);
    expect(operator.text).toMatch(/linked story/);
  });

  it("offers a Reel from the carousel's own slides, no AI video, after it is approved", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/render_reel\(workspaceId, sourceVariantId/);
    expect(operator.text).toMatch(/get_reel_render\(workspaceId, sourceVariantId\)/);
    expect(operator.text).toMatch(/no AI video/);
    expect(operator.text).toMatch(/Instagram audio library/);
    expect(operator.text).toMatch(/never a claim that a song is trending/);
    expect(operator.text).toMatch(
      /Never target `instagram_reels` here[^\n]*never built in this initial pass/,
    );
  });

  it("makes the fixed feed/Reels CTA override any brand or niche context CTA", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(
      /fixed formula always overrides any CTA the brand, niche, or channel context suggests/,
    );
    expect(operator.text).toMatch(/cta_missing/);
  });

  it("keeps negative reviews and limitations out of the post even when context asks to state them", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/explicitar limitações reais/);
    expect(operator.text).toMatch(/recurring real defect, recommend dropping the product/);
  });

  it("tells the operator a processing publish is normal, never an error, and never to re-publish", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/provider_still_processing/);
    expect(operator.text).toMatch(/O Instagram leva alguns minutos para processar/);
    expect(operator.text).toMatch(/Never suggest re-publishing/);
  });

  it("renders Stories for their own canvas without a separate image import", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/renderer renders Stories against their 1080x1920 canvas/);
    expect(operator.text).toMatch(
      /build_post_creatives\(workspaceId, contentItemId, slides, channelIds\)/,
    );
  });

  it("opens the voice script on the hook and offers a useful-tip-first angle", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/never open with a greeting or preamble/);
    expect(operator.text).toMatch(/the product appears only as the fix on the mechanism slide/);
  });

  it("starts the Reel render at approval and only asks once whether to publish it", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(
      /immediately call render_reel\(workspaceId, sourceVariantId: <that variantId>\) once right after approve_content succeeds, without asking/,
    );
    expect(operator.text).toMatch(/Ask the operator once whether to publish it/);
  });

  it("states a price without a verification date and mentions shipping only when free", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).not.toMatch(/price_without_date/);
    expect(operator.text).toMatch(/no verification date/);
    expect(operator.text).toMatch(/Never mention shipping unless `free_shipping` is true/);
  });

  it("reconciles unknown-outcome attempts before showing the pending table", async () => {
    const pending = await readSkill(pendingSkillUri);
    expect(pending.text).toMatch(
      /Before showing anything, call reconcile_publication once for each item whose `nextAction` is `reconcile`/,
    );
  });

  it("never reposts a product still in its niche's cooldown without the operator naming it", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(
      /never pick one with `inCooldown: true` unless the operator names it explicitly/,
    );
    expect(operator.text).toMatch(/prefer a product that was never posted/);
    expect(operator.text).toMatch(/recentProducts/);
    expect(operator.text).toMatch(/recently_posted/);
    expect(operator.text).toMatch(/use a different angle or hook than the (earlier|previous) post/);
  });

  it("gates the operator flow only on structure and integrations", async () => {
    const operator = await readSkill(skillUri);
    // first_post is what this flow produces and plugins is always unavailable: neither may
    // send a workspace back to setup, or the first post can never be made.
    expect(operator.text).not.toMatch(/any stage that is not `optional` is not `done`/);
    expect(operator.text).not.toMatch(/a stage that is not `optional` and not done/);
    expect(operator.text).toMatch(/`structure` or `integrations` is not `done`/);
    expect(operator.text).toMatch(/`plugins`, `first_post`, and optional stages never block/);
  });

  it("routes TikTok Shop status through real tools and never guesses a state", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/get_tiktok_shop_status\(workspaceId, channelId\)/);
    expect(operator.text).toMatch(
      /TikTok Shop status: UNKNOWN — automatic verification unavailable/,
    );
    expect(operator.text).toMatch(/TikTok Studio.*TikTok Shop para criadores/);
    expect(operator.text).toMatch(/record_tiktok_shop_status\(workspaceId, channelId, state/);
    expect(operator.text).toMatch(/SHOP_STATUS_NOTE_SENSITIVE/);
    expect(operator.text).toMatch(/bought followers, follow-for-follow/);
  });

  it("documents the TikTok Shop manual selling flow with real tools and both readiness errors", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/import_tiktok_shop_product\(workspaceId, productUrl/);
    expect(operator.text).toMatch(/create_content_variant.*tiktok_video/);
    expect(operator.text).toMatch(/tiktok_caption_link/);
    expect(operator.text).toMatch(/SHOP_NOT_ENABLED/);
    expect(operator.text).toMatch(/COMMERCIAL_SNAPSHOT_STALE/);
    expect(operator.text).toMatch(/record_manual_publication\(workspaceId, variantId\)/);
    expect(operator.text).toMatch(
      /publish_content` on a `tiktok_video` or `tiktok_photo_post` variant sends a draft/,
    );
    expect(operator.text).toMatch(/GMV\/commission import is PLANNED/);
  });

  it("gives the anti-slop checklist and marks AI use as not a defect", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/## Anti-slop checklist/);
    for (const check of [
      "thesis",
      "value",
      "hook",
      "100-test",
      "evidence",
      "fidelity",
      "duplicate",
      "cta-removed",
      "disclosure",
    ])
      expect(operator.text).toContain(check);
    expect(operator.text).toMatch(/AI-assisted production is not itself a defect/);
    expect(operator.text).toMatch(
      /This gate applies to Mercado Livre, TikTok Shop and editorial content alike/,
    );
  });

  it("documents keyword research output format, operator-assisted sources, and generic hashtags", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(
      /term, type, why relevant, evidence\/source, competition\/context, recommended test, checkedAt/,
    );
    expect(operator.text).toMatch(/import_niche_research\(provider: "manual"/);
    expect(operator.text).toMatch(/Creator Search Insights/);
    expect(operator.text).toMatch(/generic_hashtag:<tag>/);
    expect(operator.text).toMatch(/threads_multiple_topic_tags/);
  });

  it("keeps amplification research-only with no spend tool", async () => {
    const operator = await readSkill(skillUri);
    expect(operator.text).toMatch(/## Amplification/);
    expect(operator.text).toMatch(/No spend tool exists/);
    expect(operator.text).toMatch(/Organic signal always comes first/);
  });

  it("creates TikTok channels on each profile's Post For Me connection during setup", async () => {
    const setup = await readSkill(setupSkillUri);
    expect(setup.text).toMatch(/create_channel\(workspaceId, connectionId, kind: "tiktok_video"\)/);
    expect(setup.text).toMatch(/Connect an Account → TikTok/);
    expect(setup.text).toMatch(/record_tiktok_shop_status/);
  });

  it("finishes TikTok pending work as a draft with the product to attach", async () => {
    const pending = await readSkill(pendingSkillUri);
    expect(pending.text).not.toMatch(/`manual_tiktok`/);
    expect(pending.text).toMatch(/tiktokShop/);
    expect(pending.text).toMatch(/`publish` sends a draft to the TikTok app/);
  });
});
