import type { Learning } from "../analytics/learnings.js";
import type { ChannelKind } from "../channels/channel.js";
import type { CreativeFormat, LearningFeature } from "./content.js";
import { isRendererRecommendable, RENDERER_BY_FORMAT } from "./renderer-catalog.js";

/**
 * Recommends how the next post should be made (spec 3.4). Pure and seeded: the same inputs and
 * seed always return the same answer. It recommends; approval and policy still decide.
 */
const hookMoves = ["curiosity_gap", "bold_claim", "contrast", "proof_first"] as const;
type HookMove = (typeof hookMoves)[number];

const videoKinds: readonly ChannelKind[] = ["instagram_reels", "youtube", "tiktok_video"];
const formatKinds: Readonly<Record<CreativeFormat, readonly ChannelKind[]>> = {
  carousel: ["instagram_carousel"],
  reel_slides: videoKinds,
  stickman_explainer: videoKinds,
  owned_clip: videoKinds,
  ai_story: videoKinds,
};
const pipelines: Readonly<Record<CreativeFormat, string>> = {
  carousel: "build_post_creatives",
  reel_slides: "build_post_creatives + render_reel",
  stickman_explainer: "create_video_storyboard + render_long_form",
  owned_clip: "render_owned_clip",
  ai_story: "create_story_assets",
};
const formatOrder = Object.keys(formatKinds) as CreativeFormat[];
export const DEFAULT_EXPLORATION_RATE = 0.25;

export type FormatDirectorInput = Readonly<{
  /** Stable per content item so a retry gets the same choice. */
  seed: string;
  nicheId: string;
  /** Offer id (or other topic) being made; scopes the experiment key so arms compare like with like. */
  topic?: string | undefined;
  nicheKind: "affiliate" | "media";
  channelKinds: readonly ChannelKind[];
  hasProductPhoto: boolean;
  hasOwnedLongFormSource: boolean;
  allowedFormats?: readonly string[] | undefined;
  learnings: readonly Learning[];
  /** Newest first. */
  recentFormats: readonly Readonly<{
    format?: CreativeFormat | undefined;
    hookMove?: string | undefined;
  }>[];
  explorationRate?: number | undefined;
  /** Niche opt-in (`experiments.allowTrialRenderers`) to formats whose renderer is a trial. */
  allowTrialRenderers?: boolean | undefined;
}>;
export type FormatRecommendation = Readonly<{
  format: CreativeFormat | null;
  pipeline: string | null;
  durationSec?: number;
  hookMove: HookMove | null;
  experiment?: Readonly<{ key: string; arm: string; feature: LearningFeature }>;
  reasons: readonly string[];
}>;

/** FNV-1a: small, stable across runtimes. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return value;
};
const rotate = <T>(items: readonly T[], by: number): T[] =>
  items.map((_, index) => items[(index + by) % items.length] as T);

const eligibleFormats = (input: FormatDirectorInput): CreativeFormat[] =>
  formatOrder.filter((format) => {
    if (!formatKinds[format].some((kind) => input.channelKinds.includes(kind))) return false;
    if (input.allowedFormats && !input.allowedFormats.includes(format)) return false;
    const renderer = RENDERER_BY_FORMAT[format];
    if (
      renderer &&
      !isRendererRecommendable(renderer, { allowTrial: input.allowTrialRenderers === true })
    )
      return false;
    if (format === "owned_clip") return input.hasOwnedLongFormSource;
    if (format === "stickman_explainer") return input.nicheKind === "media";
    return input.nicheKind === "affiliate" && input.hasProductPhoto;
  });

const defaultDuration = (
  format: CreativeFormat,
  kinds: readonly ChannelKind[],
): number | undefined => {
  if (format === "carousel") return undefined;
  if (format === "stickman_explainer") return kinds.includes("youtube") ? 240 : 45;
  return 30;
};

export const recommendFormat = (input: FormatDirectorInput): FormatRecommendation => {
  const eligible = eligibleFormats(input);
  if (eligible.length === 0)
    return {
      format: null,
      pipeline: null,
      hookMove: null,
      reasons: ["no format is eligible for these channels, niche kind, assets and policy"],
    };
  const reasons: string[] = [];
  const winner = (feature: LearningFeature) =>
    input.learnings.find((entry) => entry.feature === feature && entry.status === "learning")
      ?.winner;
  const seen = (feature: LearningFeature) =>
    input.learnings
      .filter((entry) => entry.feature === feature)
      .reduce((sum, entry) => sum + entry.nA + entry.nB, 0);

  const rate = input.explorationRate ?? DEFAULT_EXPLORATION_RATE;
  const explore = (hash(`explore:${input.seed}`) % 10_000) / 10_000 < rate;
  const exploreFeatures: LearningFeature[] =
    eligible.length > 1 ? ["format", "hookMove"] : ["hookMove"];
  const exploring = explore
    ? exploreFeatures.reduce((best, feature) => (seen(feature) < seen(best) ? feature : best))
    : undefined;

  const wonFormat = winner("format");
  let formats = rotate(eligible, hash(`format:${input.seed}`) % eligible.length);
  if (exploring !== "format" && wonFormat && eligible.includes(wonFormat as CreativeFormat)) {
    formats = [wonFormat as CreativeFormat];
    reasons.push(`format ${wonFormat} won a one-feature comparison`);
  }
  const wonHook = winner("hookMove");
  let hooks: HookMove[] = rotate(hookMoves, hash(`hook:${input.seed}`) % hookMoves.length);
  if (exploring !== "hookMove" && wonHook && (hookMoves as readonly string[]).includes(wonHook)) {
    hooks = [wonHook as HookMove];
    reasons.push(`hook move ${wonHook} won a one-feature comparison`);
  }

  const recent = input.recentFormats.slice(0, 3);
  const pairs = formats.flatMap((format) => hooks.map((hookMove) => ({ format, hookMove })));
  const fresh = pairs.find(
    (pair) =>
      !recent.some((entry) => entry.format === pair.format && entry.hookMove === pair.hookMove),
  );
  const choice = fresh ?? (pairs[0] as { format: CreativeFormat; hookMove: HookMove });
  if (!fresh) reasons.push("every candidate repeats a recent post; novelty could not be satisfied");
  else if (pairs[0] !== fresh)
    reasons.push("skipped a format and hook pair used in the last 3 posts");

  const experiment = exploring
    ? {
        key: `${input.nicheId}:${input.topic ?? "niche"}:${[...input.channelKinds].sort().join("+")}:${exploring}`,
        arm: exploring === "format" ? choice.format : choice.hookMove,
        feature: exploring,
      }
    : undefined;
  if (experiment) reasons.push(`exploration arm on ${exploring}`);
  const durationSec = defaultDuration(choice.format, input.channelKinds);
  return {
    format: choice.format,
    pipeline: pipelines[choice.format],
    ...(durationSec !== undefined ? { durationSec } : {}),
    hookMove: choice.hookMove,
    ...(experiment ? { experiment } : {}),
    reasons,
  };
};
