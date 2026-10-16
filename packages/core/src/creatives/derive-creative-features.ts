import type { ChannelKind } from "../channels/channel.js";
import type { CreativeFeatures } from "../content/content.js";
import type { CreativeDocument } from "./creative-document.js";
import type { PriceDisplay } from "./price-display.js";
import type { SlideSpec } from "./slide-spec.js";

export type DerivedCreativeFeatures = Pick<
  CreativeFeatures,
  "priceShown" | "discountShown" | "ratingShown"
> &
  Partial<
    Pick<CreativeFeatures, "format" | "headlineLength" | "layoutFamily" | "productMode" | "ctaKind">
  >;

const lengthBucket = (length: number) =>
  length <= 25 ? ("short" as const) : length <= 45 ? ("medium" as const) : ("long" as const);

/**
 * Features that follow from data the system already holds. Pure; never guesses the operator-only
 * judgements (hookMove, angle, proofType, urgency). Callers merge with `{ ...derived, ...existing }`
 * so an explicit operator choice always wins.
 */
export const deriveCreativeFeatures = (input: {
  channelKind?: ChannelKind;
  slides: readonly SlideSpec[];
  price: PriceDisplay | null;
  /** Stored documents of the rendered slides; omit before render. */
  documents?: readonly CreativeDocument[];
}): DerivedCreativeFeatures => {
  const { slides, price, documents } = input;
  const priceShown = price !== null && slides.some((slide) => slide.badge);
  const headline = slides[0]?.headline.length ?? 0;
  const first = documents?.[0];
  const cta = documents?.findLast((doc) => doc.cta)?.cta;
  return {
    ...(input.channelKind === "instagram_carousel"
      ? { format: "carousel" as const }
      : input.channelKind === "instagram_reels"
        ? { format: "reel_slides" as const }
        : {}),
    priceShown,
    discountShown: priceShown && price?.discountPct !== undefined,
    ratingShown: slides.some((slide) =>
      slide.claims.some((claim) => claim.factKey?.startsWith("rating_")),
    ),
    ...(headline > 0 ? { headlineLength: lengthBucket(headline) } : {}),
    ...(first ? { layoutFamily: first.layoutFamily, productMode: first.layers.product.mode } : {}),
    ...(cta ? { ctaKind: cta.kind } : {}),
  };
};
