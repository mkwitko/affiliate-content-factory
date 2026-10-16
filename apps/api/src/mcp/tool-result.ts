export type ToolErrorCode =
  | "FORBIDDEN"
  | "INVALID_ARGUMENTS"
  | "INVALID_TRANSCRIPT"
  | "INVALID_EMAIL"
  | "INVALID_EXPIRY"
  | "CONNECTION_ALREADY_EXISTS"
  | "CONNECTION_NOT_FOUND"
  | "INVALID_API_KEY"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_CREDENTIALS"
  | "CONTENT_NOT_FOUND"
  | "SOURCE_NOT_FOUND"
  | "OFFER_NOT_ACTIVE"
  | "JOB_QUEUE_UNAVAILABLE"
  | "PENDING_RENDER"
  | "INVALID_CONTENT"
  | "OFFER_FACTS_CHANGED"
  | "CONTENT_NOT_APPROVED"
  | "CONNECTION_UNAVAILABLE"
  | "CANVA_NOT_CONNECTED"
  | "CANVA_TOKEN_INVALID"
  | "CANVA_EXPORT_TIMED_OUT"
  | "CANVA_EXPORT_FAILED"
  | "CANVA_PAGE_BLANK"
  | "CHANNEL_UNSUPPORTED"
  | "OFFER_UNEXPECTED"
  | "LINK_PLACEHOLDER_WITHOUT_OFFER"
  | "EDITORIAL_PUBLICATION_NOT_ENABLED"
  | "APPROVAL_STALE"
  | "SCRIPT_BINDING_MISMATCH"
  | "SCRIPT_ALREADY_APPROVED"
  | "SCRIPT_VERSION_CONFLICT"
  | "SCRIPT_NOT_APPROVED"
  | "EDITORIAL_REVIEW_MISSING"
  | "EDITORIAL_REVIEW_STALE"
  | "RIGHTS_UNVERIFIED"
  | "PUBLISH_SPEC_MISSING"
  | "PUBLISH_SPEC_INVALID"
  | "ASSET_DURATION_UNKNOWN"
  | "SHORT_FORMAT_INVALID"
  | "THUMBNAIL_INVALID"
  | "STORYBOARD_ASSET_INVALID"
  | "STORYBOARD_COVERAGE_INVALID"
  | "STORYBOARD_VERSION_CONFLICT"
  | "CHANNEL_NOT_STORIES"
  | "CHANNEL_NOT_MANUAL"
  | "CHANNEL_NOT_CAROUSEL"
  | "COMMERCE_DESTINATION_UNSUPPORTED"
  | "CAPTION_LINK_NOT_ALLOWED"
  | "REEL_SOURCE_MISMATCH"
  | "VOICE_SCRIPT_UNSUPPORTED"
  | "VOICE_SCRIPT_LENGTH_MISMATCH"
  | "VOICE_SCRIPT_ITEM_INVALID"
  | "CLIP_TIMING_UNAVAILABLE"
  | "CLIP_SPAN_UNMATCHED"
  | "CLIP_TIME_RANGE_INVALID"
  | "CLIP_DURATION_INVALID"
  | "MANUAL_PUBLICATION_REQUIRED"
  | "AFFILIATE_LINK_UNRESOLVED"
  | "AFFILIATE_URL_INVALID"
  | "NOT_FOUND"
  | "PUBLICATION_NOT_RECONCILABLE"
  | "PUBLICATION_STILL_UNKNOWN"
  | "UNAUTHENTICATED"
  | "INTERNAL_ERROR"
  | "CHANNEL_NOT_TIKTOK"
  | "SHOP_NOT_ENABLED"
  | "COMMERCIAL_SNAPSHOT_STALE"
  | "FIDELITY_BLOCKED"
  | "PREPUBLISH_BLOCKED"
  | "EXPERIMENT_ARM_MISMATCH"
  | "SHOP_STATUS_NOTE_SENSITIVE"
  | "NICHE_KIND_MISMATCH"
  | "TRIAL_RENDERER_NOT_ENABLED"
  | "AI_DISCLOSURE_MISSING"
  | "CONTENT_ALREADY_APPROVED"
  | "VARIANT_NOT_EDITABLE"
  | "SLIDE_NOT_FOUND"
  | "NOT_RETRYABLE"
  | "CREATIVE_SLIDES_MISSING";
export type DynamicToolErrorCode =
  | `CREATIVE_QUALITY_REJECTED:${"generic_hook" | "repeated_slide_copy"}`
  | `CLAIM_WITHOUT_EVIDENCE:${string}`
  | `CLAIM_UNRESOLVED:${string}`
  | `RIGHTS_UNVERIFIED:${string}`
  | `RENDER_FAILED:${string}`
  | `STORYBOARD_ASSET_INVALID:${string}`
  | `INVALID_CONTENT:${string}`
  | `COPY_REJECTED:${string}`
  | `EXPLAINER_SCRIPT_REJECTED:${string}`
  | `EPISODE_PLAN_REJECTED:${string}`
  | `CONTINUITY_REJECTED:${string}`
  | `EPISODE_IDEA_REJECTED:${string}`
  | `STORYBOARD_SCENE_INVALID:${string}`
  | `STORYBOARD_VOICE_INVALID:${string}`;
export type ToolError = ToolErrorCode | DynamicToolErrorCode;

export type ToolResult =
  | Readonly<{ ok: true; value: Record<string, unknown> }>
  | Readonly<{ ok: false; error: ToolError }>;

export const errorMessages: Readonly<Record<ToolErrorCode, string>> = {
  FORBIDDEN: "Access denied",
  INVALID_ARGUMENTS: "Tool arguments are invalid",
  INVALID_TRANSCRIPT: "Transcript format or cues are invalid",
  INVALID_EMAIL: "A valid email is required",
  INVALID_EXPIRY: "Invitation expiry must be in the future",
  CONNECTION_ALREADY_EXISTS: "Connection already exists",
  CONNECTION_NOT_FOUND: "Connection not found",
  INVALID_API_KEY: "Post For Me rejected this API key",
  ACCOUNT_NOT_FOUND: "Instagram account not found for this API key",
  INVALID_CREDENTIALS: "The provider rejected these credentials",
  CONTENT_NOT_FOUND: "Content dependency not found",
  SOURCE_NOT_FOUND: "YouTube video was not found or is unavailable",
  OFFER_NOT_ACTIVE: "Offer is not active",
  JOB_QUEUE_UNAVAILABLE: "Creative render job could not be queued; retry the build",
  PENDING_RENDER: "Creative slides are still rendering; retry preview shortly",
  INVALID_CONTENT: "Content draft is invalid",
  OFFER_FACTS_CHANGED:
    "A fact this post cites (price, discount, rating, review count, or availability) changed since its content item was created. Call get_offer, create a new content item from the active snapshot, and regenerate the slides and caption that show the changed fact.",
  CONTENT_NOT_APPROVED: "Content must be approved before publication",
  CONNECTION_UNAVAILABLE: "Provider connection is unavailable",
  CANVA_NOT_CONNECTED: "Connect Canva for this workspace first",
  CANVA_TOKEN_INVALID:
    "Canva rejected this workspace's stored authorization. Reconnect Canva on the dashboard (Integrações) and retry.",
  CANVA_EXPORT_TIMED_OUT:
    "Canva did not finish exporting the design within one minute. Retry once; if it repeats, export fewer pages.",
  CANVA_EXPORT_FAILED:
    "Canva could not export this design. Check the designId and that the design still exists in the connected Canva account.",
  CANVA_PAGE_BLANK:
    "A requested Canva page is blank (one solid color). A design often keeps an empty page when slides are added to it: call get-design-pages, delete the blank page or pass only the filled page numbers in slide order, then sync again.",
  CHANNEL_UNSUPPORTED:
    "This channel kind cannot be published yet. Use instagram_carousel, instagram_stories, or threads.",
  OFFER_UNEXPECTED: "Remove the commerce offer binding from this editorial content.",
  COMMERCE_DESTINATION_UNSUPPORTED:
    "This offer's marketplace has no supported destination on this channel (a tiktok_shop offer only attaches to tiktok_video; on TikTok a mercado_livre offer goes only to tiktok_video, through the profile).",
  CAPTION_LINK_NOT_ALLOWED:
    "TikTok captions have no clickable links. Remove {link} and any URL; point viewers to the profile instead (for example the Instagram icon or the bio link).",
  LINK_PLACEHOLDER_WITHOUT_OFFER: "Remove {link} from the caption or bind an offer.",
  EDITORIAL_PUBLICATION_NOT_ENABLED:
    "Editorial publication is not enabled until its S4 review gates are implemented.",
  APPROVAL_STALE: "The publication changed after approval. Preview and approve it again.",
  SCRIPT_BINDING_MISMATCH:
    "The script checksum changed; read the current version before approving it.",
  SCRIPT_ALREADY_APPROVED: "Approved scripts are immutable; create a new version.",
  SCRIPT_VERSION_CONFLICT:
    "Another script version was created concurrently; read the latest version and retry.",
  SCRIPT_NOT_APPROVED:
    "Approve a source-grounded script before reviewing or publishing this YouTube variant.",
  EDITORIAL_REVIEW_MISSING:
    "Record a passing editorial review for the current publication fingerprint.",
  EDITORIAL_REVIEW_STALE: "The reviewed publication changed. Preview and record the review again.",
  RIGHTS_UNVERIFIED: "A required asset has unknown or disallowed commercial rights.",
  PUBLISH_SPEC_MISSING: "YouTube variants require a valid publishSpec.",
  PUBLISH_SPEC_INVALID: "The YouTube publishSpec is invalid for this channel or field.",
  ASSET_DURATION_UNKNOWN:
    "The YouTube MP4 duration is unknown; re-import the video with media metadata.",
  SHORT_FORMAT_INVALID:
    "A YouTube Short must be square or vertical and no longer than three minutes.",
  THUMBNAIL_INVALID: "The thumbnail must be a separate active JPEG or PNG in this workspace.",
  STORYBOARD_ASSET_INVALID:
    "A storyboard scene must reference an active image asset in this workspace.",
  STORYBOARD_COVERAGE_INVALID:
    "Storyboard scenes must cover the approved script contiguously, without gaps or overlaps.",
  STORYBOARD_VERSION_CONFLICT:
    "A storyboard version was created concurrently; read the latest version and retry.",
  CHANNEL_NOT_STORIES: "This tool only works for a variant on an instagram_stories channel.",
  CHANNEL_NOT_MANUAL:
    "This tool only works for a variant on a manual-publication channel (instagram_stories or tiktok_video).",
  CHANNEL_NOT_CAROUSEL:
    "render_reel only works for a variant on an instagram_carousel channel, and only once it is approved or published.",
  REEL_SOURCE_MISMATCH:
    "This video was not rendered from an instagram_carousel variant of this contentItemId. Call get_reel_render with this post's own carousel variantId and use the assetId it returns.",
  VOICE_SCRIPT_UNSUPPORTED: "voiceScript is only supported on instagram_carousel channels.",
  VOICE_SCRIPT_LENGTH_MISMATCH: "voiceScript must have exactly one sentence per slide (assetId).",
  VOICE_SCRIPT_ITEM_INVALID:
    "A voiceScript sentence is empty, too long, a hashtag, a {link} placeholder, or has no letters.",
  CLIP_TIMING_UNAVAILABLE: "This render has no usable timing manifest.",
  CLIP_SPAN_UNMATCHED: "The selected script passage could not be mapped to timed words.",
  CLIP_TIME_RANGE_INVALID: "The requested time range is outside this render or has invalid bounds.",
  CLIP_DURATION_INVALID: "The selected passage is outside the supported clip duration.",
  MANUAL_PUBLICATION_REQUIRED:
    "Stories need a link sticker, which only the Instagram app can add. Use get_story_kit, post in the app, then record_manual_publication.",
  AFFILIATE_LINK_UNRESOLVED:
    "The affiliate link did not lead to a Mercado Livre catalog product (/p/MLB…). Search the product by name and pass its productId with the same affiliate link.",
  AFFILIATE_URL_INVALID: "Use an HTTPS affiliate URL issued by Mercado Livre.",
  NOT_FOUND: "Resource not found",
  PUBLICATION_NOT_RECONCILABLE: "Only unknown publications can be reconciled",
  PUBLICATION_STILL_UNKNOWN: "The provider has not returned a unique result",
  UNAUTHENTICATED: "Authentication required",
  INTERNAL_ERROR: "An unexpected error occurred",
  CHANNEL_NOT_TIKTOK: "This tool only works for a variant or channel of kind tiktok_video.",
  SHOP_NOT_ENABLED:
    "TikTok Shop is not confirmed enabled for this channel (no operator confirmation, or it is older than 30 days). Call record_tiktok_shop_status, then get_tiktok_shop_status.",
  COMMERCIAL_SNAPSHOT_STALE:
    "The TikTok Shop commercial snapshot is missing or older than 24 hours. Call import_tiktok_shop_product with a fresh observation.",
  FIDELITY_BLOCKED:
    "Product fidelity QA blocked this render: the product in a slide no longer matches the listing photo. Read creativeRender.fidelity in list_pending_content, fix the slides and rebuild with build_post_creatives; never approve around it.",
  PREPUBLISH_BLOCKED:
    "The pre-publish score has a failed hard check (see prepublishScore in list_pending_content or preview_content). Fix the named check and rebuild; never approve around it.",
  EXPERIMENT_ARM_MISMATCH:
    "Variants of one experiment key must share the declared feature, offer (or niche), channel kind and language; they differ only in the experiment feature.",
  SHOP_STATUS_NOTE_SENSITIVE:
    "This note looks like it contains a CPF or CNPJ number. Money Maker never stores identity or tax documents; remove the number and retry.",
  NICHE_KIND_MISMATCH:
    "This action does not apply to this niche kind. Offers and product creatives are for affiliate niches; SceneSpec storyboards and stickman renders are for media niches.",
  TRIAL_RENDERER_NOT_ENABLED:
    "The ai_clips renderer is a trial. Set experiments.allowTrialRenderers to true on the niche context (update_niche_context) before creating an ai_clips storyboard.",
  AI_DISCLOSURE_MISSING:
    'This post is built on AI-generated scene clips. Add a clear AI disclosure to the caption, such as "Cenas geradas por IA." or #IA, then approve again (the clip provider\'s terms require it).',
  CONTENT_ALREADY_APPROVED:
    "This post already has an approved, scheduled or published variant, so its text cannot change. Reject or cancel it first, then rebuild with build_post_creatives.",
  VARIANT_NOT_EDITABLE:
    "Only a draft or awaiting-approval variant's caption can be edited; this one is approved, scheduled, published, rejected or cancelled.",
  NOT_RETRYABLE: "This job is not a failed package step that can be retried.",
  SLIDE_NOT_FOUND: "No slide has that index in this post.",
  CREATIVE_SLIDES_MISSING: "This post has no built slides yet; wait for the package to finish.",
};

const errorMessage = (code: ToolError) => {
  if (code === "CREATIVE_QUALITY_REJECTED:generic_hook")
    return "The opening hook is generic. Rewrite it around this specific product, problem, or idea before generating media.";
  if (code === "CREATIVE_QUALITY_REJECTED:repeated_slide_copy")
    return "The slide deck repeats the same copy. Give each slide a distinct useful point before generating media.";
  if (code.startsWith("CLAIM_WITHOUT_EVIDENCE:"))
    return `No offer fact supports ${code.slice("CLAIM_WITHOUT_EVIDENCE:".length)}`;
  if (code.startsWith("CLAIM_UNRESOLVED:"))
    return `Claim ${code.slice("CLAIM_UNRESOLVED:".length)} cites missing or cross-workspace evidence`;
  if (code.startsWith("RIGHTS_UNVERIFIED:"))
    return `Commercial rights are not verified for asset ${code.slice("RIGHTS_UNVERIFIED:".length)}`;
  if (code.startsWith("RENDER_FAILED:"))
    return `Creative rendering failed: ${code.slice("RENDER_FAILED:".length)}`;
  if (code.startsWith("STORYBOARD_ASSET_INVALID:"))
    return `Storyboard scene ${code.slice("STORYBOARD_ASSET_INVALID:".length)} references an unavailable or invalid asset`;
  if (code.startsWith("INVALID_CONTENT:"))
    return `Content draft is invalid: ${code.slice("INVALID_CONTENT:".length)}`;
  if (code.startsWith("COPY_REJECTED:"))
    return `The new text was rejected (${code.slice("COPY_REJECTED:".length)}): links, @handles, hashtags, unproven shipping or discount words and numbers without a verified fact are not allowed; the system adds the CTA and #publi itself`;
  if (code.startsWith("EXPLAINER_SCRIPT_REJECTED:"))
    return `Explainer script rejected (${code.slice("EXPLAINER_SCRIPT_REJECTED:".length)}); see the money-maker-explainer skill error map`;
  if (code.startsWith("EPISODE_PLAN_REJECTED:"))
    return `Episode plan rejected (${code.slice("EPISODE_PLAN_REJECTED:".length)}); rerun create_episode_plan and fix the violations`;
  if (code.startsWith("CONTINUITY_REJECTED:"))
    return `Continuity facts rejected (${code.slice("CONTINUITY_REJECTED:".length)}); supersede the earlier fact when something moves or changes hands`;
  if (code.startsWith("EPISODE_IDEA_REJECTED:"))
    return `Episode idea rejected (${code.slice("EPISODE_IDEA_REJECTED:".length)}); fix the named problem and retry`;
  if (code.startsWith("STORYBOARD_VOICE_INVALID:"))
    return code.endsWith(":voice_language_mismatch")
      ? "The narration voice does not speak the script's language"
      : "No narration voice: pass voiceId or set one on the niche's main character or the niche";
  if (code.startsWith("STORYBOARD_SCENE_INVALID:"))
    return `Storyboard scene ${code.slice("STORYBOARD_SCENE_INVALID:".length).replace(":", " is invalid: ")}`;
  return errorMessages[code as ToolErrorCode];
};

export const toMcpToolResult = (result: ToolResult) => {
  if (result.ok) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
      structuredContent: result.value,
    };
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: errorMessage(result.error) }],
    structuredContent: {
      error: { code: result.error, message: errorMessage(result.error) },
    },
  };
};
