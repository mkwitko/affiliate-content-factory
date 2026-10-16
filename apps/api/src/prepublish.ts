import type { WorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import { copyClaimProblems } from "@money-maker/core/content/claim-verifier";
import type { ContentItem, ContentVariant } from "@money-maker/core/content/content";
import { ownerCopyPolicyCode } from "@money-maker/core/content/offer-copy";
import {
  type PrepublishInput,
  type PrepublishScore,
  scorePrepublish,
} from "@money-maker/core/content/prepublish-score";
import { hasGenericHookOpener } from "@money-maker/core/creatives/slide-spec";
import type { Offer } from "@money-maker/core/offers/offer";
import type { ReelRenderRepository } from "@money-maker/core/publishing/reel-render";
import type { PublicationPolicy } from "@money-maker/core/workspaces/publication-policy";

const DAY_MS = 86_400_000;
const textChannels: readonly Channel["kind"][] = [
  "instagram_carousel",
  "instagram_stories",
  "threads",
  "tiktok_photo_post",
];

/**
 * Gathers the score inputs this system really stores (spec ruling 2): unknown inputs stay
 * absent so their checks read n/a. Computed on read and at approval; never persisted.
 */
export const prepublishScoreFor = async (input: {
  workspaceId: WorkspaceId;
  variant: ContentVariant;
  item: ContentItem;
  channel: Channel;
  offer: Offer | null;
  policy?: Pick<PublicationPolicy, "evidenceMaxAgeDays"> | undefined;
  reelRenders?: ReelRenderRepository | undefined;
  now?: Date;
}): Promise<PrepublishScore> => {
  const { variant, item, channel, offer } = input;
  const format =
    variant.creativeFeatures?.format ??
    (textChannels.includes(channel.kind) ? "carousel" : "reel_slides");
  const firstAsset = variant.assetIds[0];
  const render =
    format !== "carousel" && firstAsset && input.reelRenders
      ? await input.reelRenders.findByAssetForWorkspace({
          workspaceId: input.workspaceId,
          assetId: firstAsset,
        })
      : null;
  const fidelity = variant.creativeRender?.fidelity?.verdict;
  const hooks = [item.creativeSlides?.[0]?.headline, variant.voiceScript[0]].filter(
    (hook): hook is string => Boolean(hook),
  );
  const hookText = hooks.find(hasGenericHookOpener) ?? hooks[0];
  const snapshot = offer?.snapshots.find((entry) => entry.id === variant.offerSnapshotId);
  const copy = [
    variant.caption,
    ...(item.creativeSlides ?? []).flatMap((slide) => [slide.headline, slide.body ?? ""]),
  ].join("\n");
  const priceShown =
    variant.creativeFeatures?.discountShown === true ||
    variant.creativeFeatures?.priceShown === true ||
    /R\$\s?\d/.test(copy) ||
    (Boolean(variant.offerSnapshotId) && variant.creativeFeatures?.priceShown !== false);
  const cta = channel.context?.cta;
  const durationSec =
    variant.creativeFeatures?.durationSec ??
    (render?.durationMs ? render.durationMs / 1000 : undefined);
  const scoreInput: PrepublishInput = {
    format,
    channelKind: channel.kind,
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(hookText ? { hookText } : {}),
    ...(typeof cta === "string" && cta.trim()
      ? { cta: { expected: cta.trim(), copy: variant.caption } }
      : {}),
    ...(snapshot
      ? {
          price: {
            shown: priceShown,
            evidenceAgeDays:
              ((input.now ?? new Date()).getTime() - snapshot.verifiedAt.getTime()) / DAY_MS,
            maxAgeDays: input.policy?.evidenceMaxAgeDays ?? 30,
          },
        }
      : {}),
    ...(fidelity === "pass" || fidelity === "warn" || fidelity === "block"
      ? { fidelityVerdict: fidelity }
      : {}),
    ...(render?.qualityReport ? { renderVerdict: render.qualityReport.verdict } : {}),
    ...(snapshot
      ? {
          claimProblems: [
            ...[variant.caption, ...variant.voiceScript].flatMap((text) => {
              const code = ownerCopyPolicyCode(text, snapshot.facts);
              return code ? [`${code}:${text.slice(0, 80)}`] : [];
            }),
            ...copyClaimProblems(
              [
                variant.caption,
                ...variant.voiceScript,
                ...(item.creativeSlides ?? []).flatMap((slide) => [
                  slide.headline,
                  slide.body ?? "",
                  slide.badge ?? "",
                  ...slide.claims.map((claim) => claim.text),
                ]),
              ],
              snapshot.facts,
              offer?.title,
            ),
          ],
        }
      : {}),
  };
  return scorePrepublish(scoreInput);
};

export const failedChecks = (score: PrepublishScore) =>
  score.checks
    .filter((entry) => entry.result === "fail" || entry.result === "warn")
    .map((entry) => ({ id: entry.id, result: entry.result, hard: entry.hard }));
