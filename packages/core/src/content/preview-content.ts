import type { Asset } from "../assets/asset.js";
import type { Channel } from "../channels/channel.js";
import {
  validateYouTubeVariant,
  youtubeThumbnailIsRecommended,
} from "../channels/youtube-validation.js";
import { hasGenericHookOpener } from "../creatives/slide-spec.js";
import type { CommercialFact, Money } from "../offers/offer.js";
import type { ContentVariant, VariantDesign } from "./content.js";
export type ContentPreview = Readonly<{
  assets: readonly Asset[];
  caption: string;
  cta: { mode: "link_in_bio" | "decorative" };
  evidenceAgeDays: number | null;
  destinationFingerprint: string | null;
  warnings: readonly string[];
  nextAction: "edit" | "approve" | "publish";
  design: VariantDesign | null;
  editUrl: string | null;
  youtube: Readonly<{
    title: string;
    privacyStatus: "private" | "unlisted";
    intendedFormat: "long_form" | "short";
    madeForKids: boolean;
    containsSyntheticMedia: boolean;
  }> | null;
}>;
export type PreviewEvidence =
  | Readonly<{
      kind: "commerce";
      verifiedAt: Date;
      facts: readonly CommercialFact[];
      destinationFingerprint: string;
    }>
  | Readonly<{ kind: "editorial" }>;

const isMoney = (value: unknown): value is Money =>
  typeof value === "object" && value !== null && "amountMinor" in value;
const parseDecimal = (text: string) => Number(text.replace(/\./g, "").replace(",", "."));
/**
 * Commercial numbers in a caption (prices, percentages, ratings, counts) that no fact backs.
 * Spec numbers ("10 a 17 polegadas", "Bluetooth 5.3") are not claims checked here. A
 * rounded-down count ("+10 mil vendidos" for 12.000, "+500 vendidos" for 540) is true, so it passes.
 */
export const numbersWithoutEvidence = (
  caption: string,
  facts: readonly CommercialFact[],
): string[] => {
  const prices = facts
    .map((fact) => fact.value)
    .filter(isMoney)
    .map((money) => money.amountMinor);
  const listPrice = facts.find((fact) => fact.key === "list_price")?.value;
  const currentPrice = facts.find((fact) => fact.key === "current_price")?.value;
  if (isMoney(listPrice) && isMoney(currentPrice))
    prices.push(listPrice.amountMinor - currentPrice.amountMinor);
  // The discount between two verified prices is evidence for a "50%" claim.
  const discountPct =
    isMoney(listPrice) && isMoney(currentPrice) && listPrice.amountMinor > currentPrice.amountMinor
      ? Math.floor(
          ((listPrice.amountMinor - currentPrice.amountMinor) / listPrice.amountMinor) * 100,
        )
      : undefined;
  const numbers = facts
    .map((fact) => fact.value)
    .filter((value): value is number => typeof value === "number");
  const oneDecimal = (value: number) => Math.round(value * 10) / 10;
  const factNumber = (key: string) => {
    const value = facts.find((fact) => fact.key === key)?.value;
    return typeof value === "number" ? value : undefined;
  };
  // The fact a count claim is about, by the noun that follows the number.
  const countFact = (noun: string) =>
    factNumber(
      /^avalia|^opini/i.test(noun)
        ? "review_count"
        : /^unidades/i.test(noun)
          ? "available_quantity"
          : "sold_quantity",
    );
  const count = String.raw`(\d{1,3}(?:\.\d{3})+|\d+)`;
  const countNoun = String.raw`\s(avalia[çc][õo]es|opini[õo]es|vendidos|vendas|unidades)`;
  const checks: [RegExp, (match: RegExpExecArray) => boolean][] = [
    [
      new RegExp(String.raw`R\$\s?${count}(?:,(\d{2}))?(?!\d)`, "g"),
      (match) => prices.includes(parseDecimal(match[1] ?? "") * 100 + Number(match[2] ?? 0)),
    ],
    // "100% algodão" describes the product, not the offer.
    [
      /(\d{1,3})\s?%/g,
      (match) =>
        match[1] === "100" ||
        numbers.includes(Number(match[1])) ||
        Number(match[1]) === discountPct,
    ],
    // Rounded-down counts are true claims: "+10 mil vendidos" for 12.000, "+500 vendidos" for 540.
    [
      new RegExp(String.raw`(?:\+\s?)?(\d+(?:,\d)?)\s?mil${countNoun}?`, "gi"),
      (match) => {
        const claimed = parseDecimal(match[1] ?? "") * 1000;
        const fact = match[2] ? countFact(match[2]) : undefined;
        return match[2]
          ? fact !== undefined && fact >= claimed
          : numbers.some((value) => value >= claimed);
      },
    ],
    [
      new RegExp(String.raw`\+\s?${count}${countNoun}`, "gi"),
      (match) => (countFact(match[2] ?? "") ?? -1) >= parseDecimal(match[1] ?? ""),
    ],
    [
      new RegExp(`${count}${countNoun}`, "gi"),
      (match) => countFact(match[2] ?? "") === parseDecimal(match[1] ?? ""),
    ],
    // Ratings only next to a rating word, so "Bluetooth 5.3" or "2,4 GHz" are not read as claims.
    [
      /(?:nota|m[ée]dia)\s*(?:de\s*)?(\d[.,]\d)|(\d[.,]\d)\s*(?:estrelas?|★|⭐)/gi,
      (match) => {
        const rating = Number((match[1] ?? match[2] ?? "").replace(",", "."));
        const average = factNumber("rating_average");
        return average !== undefined && oneDecimal(average) === rating;
      },
    ],
  ];
  const found: { index: number; text: string }[] = [];
  let rest = caption;
  for (const [pattern, backed] of checks) {
    for (const match of rest.matchAll(pattern)) {
      if (!backed(match)) found.push({ index: match.index, text: match[0] });
    }
    // Blank out what this pattern read so a later, looser pattern does not read it again.
    rest = rest.replace(pattern, (text) => " ".repeat(text.length));
  }
  return found.sort((left, right) => left.index - right.index).map((entry) => entry.text);
};
export const canvaEditUrl = (designId: string): string =>
  `https://www.canva.com/design/${encodeURIComponent(designId)}/edit`;

// Channels where the fixed CTA formula ("🔗 Link na bio")
// always overrides any CTA from brand, niche, or channel context.
const ctaRequiredChannelKinds: readonly Channel["kind"][] = [
  "instagram_carousel",
  "instagram_reels",
];
/** True when the caption carries the affiliate disclosure (#publi or #publicidade) anywhere. */
export const captionHasDisclosure = (caption: string): boolean =>
  /(^|\s)#publi(cidade)?\b/i.test(caption);
export const youtubeAffiliateDisclosure =
  "Este vídeo contém links de afiliado; posso receber comissão sem custo extra para você.";
// Instagram ignores hashtags past 5 per post (Dec 2025); #publi counts toward the limit.
export const instagramHashtagLimit = 5;
export const countHashtags = (caption: string): number =>
  caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0;
/** "Fone de ouvido Bluetooth" -> "#fonedeouvidobluetooth"; null when nothing usable is left. */
export const hashtagFromKeyword = (keyword: string): string | null => {
  const tag = keyword.toLowerCase().replace(/[^\p{L}\p{N}_]/gu, "");
  return tag && !/^\p{N}+$/u.test(tag) ? `#${tag}` : null;
};
/** True when a feed or Reels caption is missing the required "Link na bio" CTA. */
export const captionMissingCta = (caption: string): boolean => !/link\s+na\s+bio/i.test(caption);

// Platform hashtags that carry no niche-specific signal (playbook §7); never justified without
// an observation.
const genericHashtags: ReadonlySet<string> = new Set([
  "fyp",
  "foryou",
  "foryoupage",
  "viral",
  "trending",
  "explore",
  "reels",
  "instagood",
]);
/** Generic hashtags present in the caption, lowercased and without the `#`, in caption order. */
export const genericHashtagsIn = (caption: string): string[] =>
  (caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])
    .map((tag) => tag.slice(1).toLowerCase())
    .filter((tag) => genericHashtags.has(tag));

const tiktokCaptionChannelKinds: readonly Channel["kind"][] = ["tiktok_video", "tiktok_photo_post"];
/** True when a TikTok caption carries a clickable URL or the unresolved `{link}` placeholder;
 * TikTok captions are not clickable (playbook §7). */
export const captionHasLinkForTikTok = (caption: string): boolean =>
  /https?:\/\//i.test(caption) || caption.includes("{link}");

/** Lowercased word tokens, for a simple normalized-token similarity, not a full NLP pipeline. */
const captionTokens = (caption: string): Set<string> =>
  new Set(caption.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) ?? []);
/** Jaccard similarity of two token sets: |intersection| / |union|, 1 when both are empty. */
const jaccardSimilarity = (left: Set<string>, right: Set<string>): number => {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
};
const similarToRecentThreshold = 0.8;
/**
 * True when the caption's normalized tokens overlap at least 80% (Jaccard) with any of the given
 * recent captions. A deterministic text check (anti-slop design §7), not an ML similarity model.
 */
export const isSimilarToRecentCaption = (
  caption: string,
  recentCaptions: readonly string[],
): boolean => {
  const tokens = captionTokens(caption);
  return recentCaptions.some(
    (recent) => jaccardSimilarity(tokens, captionTokens(recent)) >= similarToRecentThreshold,
  );
};

// Channels whose captions stay up long enough that a bare price goes stale (owner decision "B").
export const previewContent = (input: {
  variant: ContentVariant;
  channel: Channel;
  assets: readonly Asset[];
  thumbnail?: Asset | null;
  evidence?: PreviewEvidence;
  /** @deprecated Retained for callers during the optional-commerce rollout. */
  evidenceVerifiedAt?: Date;
  /** @deprecated Retained for callers during the optional-commerce rollout. */
  destinationFingerprint?: string;
  /** @deprecated Retained for callers during the optional-commerce rollout. */
  facts?: readonly CommercialFact[];
  now?: Date;
  /** Up to 10 recent approved/published captions on this channel, newest first, for the
   * `similar_to_recent` check; the caller resolves and orders them. */
  recentCaptions?: readonly string[];
}): ContentPreview => {
  if (input.variant.workspaceId !== input.channel.workspaceId)
    throw new Error("workspace_mismatch");
  if (input.assets.length > input.channel.capabilities.maxAssets)
    throw new Error("asset_count_invalid");
  const expected = input.channel.capabilities.requiredAssetDimensions;
  if (
    expected &&
    input.assets.some((asset) => asset.width !== expected.width || asset.height !== expected.height)
  )
    throw new Error("asset_dimensions_invalid");
  if (input.variant.caption.length > input.channel.capabilities.captionMaxLength)
    throw new Error("caption_too_long");
  if (input.channel.kind === "youtube") {
    const problem = validateYouTubeVariant({
      spec: input.variant.publishSpec,
      asset: input.assets[0],
      thumbnail: input.thumbnail ?? undefined,
      assetIds: input.variant.assetIds,
      workspaceId: input.variant.workspaceId,
      caption: input.variant.caption,
    });
    if (problem) throw new Error(problem);
  } else if (input.variant.publishSpec) {
    throw new Error("publish_spec_unexpected");
  }
  const evidence =
    input.evidence ??
    (input.evidenceVerifiedAt && input.destinationFingerprint !== undefined
      ? {
          kind: "commerce" as const,
          verifiedAt: input.evidenceVerifiedAt,
          destinationFingerprint: input.destinationFingerprint,
          facts: input.facts ?? [],
        }
      : null);
  if (!evidence) throw new Error("preview_evidence_required");
  const now = input.now ?? new Date();
  const evidenceAgeDays =
    evidence.kind === "commerce"
      ? Math.max(0, Math.floor((now.getTime() - evidence.verifiedAt.getTime()) / 86_400_000))
      : null;
  const facts = evidence.kind === "commerce" ? evidence.facts : null;
  const checkCommercialNumbers = input.evidence?.kind === "commerce" || input.facts !== undefined;
  const warnings = [
    ...(evidenceAgeDays !== null && evidenceAgeDays > 7 ? ["evidence_expired"] : []),
    // Affiliate disclosure (CONAR) sits with the hashtags at the end of every caption; the skill
    // fixes a missing one before asking to approve.
    ...(evidence.kind === "commerce" &&
    !(input.channel.kind === "youtube"
      ? input.variant.caption.includes(youtubeAffiliateDisclosure)
      : captionHasDisclosure(input.variant.caption))
      ? ["disclosure_missing"]
      : []),
    ...(checkCommercialNumbers && facts
      ? numbersWithoutEvidence(input.variant.caption, facts).map(
          (text) => `number_without_evidence:${text}`,
        )
      : []),
    ...(checkCommercialNumbers && facts
      ? input.variant.voiceScript.flatMap((item) =>
          numbersWithoutEvidence(item, facts).map(
            (text) => `voice_number_without_evidence:${text}`,
          ),
        )
      : []),
    ...(evidence.kind === "commerce" &&
    ctaRequiredChannelKinds.includes(input.channel.kind) &&
    captionMissingCta(input.variant.caption)
      ? ["cta_missing"]
      : []),
    ...(ctaRequiredChannelKinds.includes(input.channel.kind) &&
    countHashtags(input.variant.caption) > instagramHashtagLimit
      ? ["too_many_hashtags"]
      : []),
    ...(hasGenericHookOpener(input.variant.caption) ? ["hook_generic"] : []),
    ...(input.channel.kind === "youtube" &&
    input.variant.publishSpec?.intendedFormat === "long_form" &&
    input.assets[0] &&
    input.assets[0].durationMs !== undefined &&
    input.assets[0].durationMs <= 180_000 &&
    input.assets[0].height >= input.assets[0].width
      ? ["youtube_will_classify_as_short"]
      : []),
    ...(input.channel.kind === "youtube" &&
    input.thumbnail &&
    !youtubeThumbnailIsRecommended(input.thumbnail)
      ? ["thumbnail_not_recommended"]
      : []),
    ...(input.channel.kind === "threads" && countHashtags(input.variant.caption) > 1
      ? ["threads_multiple_topic_tags"]
      : []),
    ...genericHashtagsIn(input.variant.caption).map((tag) => `generic_hashtag:${tag}`),
    ...(tiktokCaptionChannelKinds.includes(input.channel.kind) &&
    captionHasLinkForTikTok(input.variant.caption)
      ? ["tiktok_caption_link"]
      : []),
    ...(input.recentCaptions &&
    isSimilarToRecentCaption(input.variant.caption, input.recentCaptions.slice(0, 10))
      ? ["similar_to_recent"]
      : []),
  ];
  return {
    assets: input.assets,
    caption: input.variant.caption,
    cta: {
      mode: input.channel.kind === "instagram_stories" ? "link_in_bio" : "decorative",
    },
    evidenceAgeDays,
    destinationFingerprint: evidence.kind === "commerce" ? evidence.destinationFingerprint : null,
    warnings,
    nextAction: "approve",
    design: input.variant.design ?? null,
    editUrl: input.variant.design ? canvaEditUrl(input.variant.design.canvaDesignId) : null,
    youtube: input.variant.publishSpec
      ? {
          title: input.variant.publishSpec.title,
          privacyStatus: input.variant.publishSpec.privacyStatus,
          intendedFormat: input.variant.publishSpec.intendedFormat,
          madeForKids: input.variant.publishSpec.madeForKids,
          containsSyntheticMedia: input.variant.publishSpec.containsSyntheticMedia,
        }
      : null,
  };
};
