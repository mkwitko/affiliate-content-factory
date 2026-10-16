import type { CommercialSnapshot, Offer } from "../offers/offer.js";
import { TIKTOK_SHOP_SNAPSHOT_MAX_AGE_MS } from "../offers/offer.js";
import type { Channel } from "./channel.js";

export type ShopState =
  | "unknown"
  | "not_connected"
  | "not_eligible"
  | "eligible_not_onboarded"
  | "onboarding"
  | "shop_enabled"
  | "restricted"
  | "suspended";

export type ShopReason =
  | "followers"
  | "age"
  | "region"
  | "account_type"
  | "identity"
  | "policy"
  | "unknown";

export type ShopTrack =
  | "setup"
  | "growth"
  | "verification"
  | "compliance"
  | "selling"
  | "manual_diagnosis";

/** What TikTok content should aim for, derived from the recorded status (never stored). */
export type TikTokAccountStrategy = "grow_audience" | "sell_mercado_livre" | "sell_tiktok_shop";

/** Persisted at `Channel.context.tiktokShop` (design §14); an operator assertion, never polled. */
export type TikTokShopStatus = Readonly<{
  version: 1;
  state: ShopState;
  reason?: ShopReason;
  note?: string;
  /** Operator-reported: the profile can show a clickable website link (bio link). */
  bioLinkAvailable?: boolean;
  observedAt: string;
  source: "operator_confirmation";
  recheckAfter?: string;
}>;

const shopStates: readonly ShopState[] = [
  "unknown",
  "not_connected",
  "not_eligible",
  "eligible_not_onboarded",
  "onboarding",
  "shop_enabled",
  "restricted",
  "suspended",
];

const shopReasons: readonly ShopReason[] = [
  "followers",
  "age",
  "region",
  "account_type",
  "identity",
  "policy",
  "unknown",
];

/** Reads and validates `Channel.context.tiktokShop`; malformed or absent data is never invented. */
export const parseTikTokShopStatus = (
  context: Record<string, unknown> | null | undefined,
): TikTokShopStatus | null => {
  const raw = context?.tiktokShop;
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;
  if (typeof value.state !== "string" || !shopStates.includes(value.state as ShopState))
    return null;
  if (typeof value.observedAt !== "string" || Number.isNaN(Date.parse(value.observedAt)))
    return null;
  if (value.source !== "operator_confirmation") return null;
  const reason =
    typeof value.reason === "string" && shopReasons.includes(value.reason as ShopReason)
      ? (value.reason as ShopReason)
      : undefined;
  const note = typeof value.note === "string" ? value.note : undefined;
  const recheckAfter = typeof value.recheckAfter === "string" ? value.recheckAfter : undefined;
  const bioLinkAvailable =
    typeof value.bioLinkAvailable === "boolean" ? value.bioLinkAvailable : undefined;
  return Object.freeze({
    version: 1 as const,
    state: value.state as ShopState,
    ...(reason ? { reason } : {}),
    ...(note ? { note } : {}),
    ...(bioLinkAvailable === undefined ? {} : { bioLinkAvailable }),
    observedAt: value.observedAt,
    source: "operator_confirmation" as const,
    ...(recheckAfter ? { recheckAfter } : {}),
  });
};

const noteMaxLength = 500;
// Matches an 11-digit CPF or 14-digit CNPJ, with or without `.`/`-`/`/` punctuation, but not a
// digit run that is part of a longer number (identity/tax documents only; design §20).
const cpfOrCnpjPattern =
  /(?<![\d.\-/])(?:\d[.\-/]?){10}\d(?![\d.\-/])|(?<![\d.\-/])(?:\d[.\-/]?){13}\d(?![\d.\-/])/;

/**
 * Records one operator-reported TikTok Shop checklist observation. `prev` is accepted for API
 * symmetry with a future diff/audit use but is not consulted: every call is a fresh, complete
 * observation (design §8, "Transitions are operator-recorded events").
 */
export const recordTikTokShopStatus = (
  _prev: TikTokShopStatus | null,
  input: Readonly<{
    state: ShopState;
    reason?: ShopReason;
    note?: string;
    bioLinkAvailable?: boolean;
  }>,
  now: Date,
): TikTokShopStatus => {
  if (input.state === "not_eligible" && !input.reason) {
    throw new Error("shop_status_reason_required");
  }
  const note = input.note?.trim();
  if (note) {
    if (note.length > noteMaxLength) throw new Error("shop_status_note_too_long");
    if (cpfOrCnpjPattern.test(note)) throw new Error("shop_status_note_sensitive");
  }
  return Object.freeze({
    version: 1 as const,
    state: input.state,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(note ? { note } : {}),
    ...(input.bioLinkAvailable === undefined ? {} : { bioLinkAvailable: input.bioLinkAvailable }),
    observedAt: now.toISOString(),
    source: "operator_confirmation" as const,
  });
};

const SHOP_STATUS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** An operator observation older than 30 days is treated as `unknown` rather than trusted stale data. */
export const effectiveShopState = (status: TikTokShopStatus | null, now: Date): ShopState => {
  if (!status) return "unknown";
  if (now.getTime() - Date.parse(status.observedAt) > SHOP_STATUS_MAX_AGE_MS) return "unknown";
  return status.state;
};

const reasonTrack: Readonly<Record<ShopReason, ShopTrack>> = {
  followers: "growth",
  age: "growth",
  region: "manual_diagnosis",
  account_type: "setup",
  identity: "verification",
  policy: "compliance",
  unknown: "manual_diagnosis",
};

const stateTrack: Readonly<Record<Exclude<ShopState, "not_eligible">, ShopTrack>> = {
  unknown: "manual_diagnosis",
  not_connected: "setup",
  eligible_not_onboarded: "setup",
  onboarding: "verification",
  shop_enabled: "selling",
  restricted: "compliance",
  suspended: "compliance",
};

/** The next track to recommend (design §8-§13). */
export const shopTrackFor = (state: ShopState, reason?: ShopReason): ShopTrack =>
  state === "not_eligible"
    ? reason
      ? reasonTrack[reason]
      : "manual_diagnosis"
    : stateTrack[state];

/**
 * Shop selling needs a current `shop_enabled`; otherwise a reported bio link lets TikTok send
 * traffic to Mercado Livre; with neither, or a stale status, content only grows the audience.
 */
export const accountStrategyFor = (
  status: TikTokShopStatus | null,
  now: Date,
): TikTokAccountStrategy => {
  const state = effectiveShopState(status, now);
  if (state === "shop_enabled") return "sell_tiktok_shop";
  if (state !== "unknown" && status?.bioLinkAvailable === true) return "sell_mercado_livre";
  return "grow_audience";
};

/**
 * Throws `shop_not_enabled` (status missing, not SHOP_ENABLED, or older than 30 days) or
 * `commercial_snapshot_stale` (no active snapshot, or older than 24h). A no-op for any offer that
 * is not `tiktok_shop`.
 */
export const assertTikTokShopPublishable = (
  input: Readonly<{
    channel: Pick<Channel, "context">;
    offer: Pick<Offer, "marketplace">;
    snapshot: CommercialSnapshot | null | undefined;
    now: Date;
  }>,
): void => {
  if (input.offer.marketplace !== "tiktok_shop") return;
  const status = parseTikTokShopStatus(input.channel.context);
  if (effectiveShopState(status, input.now) !== "shop_enabled") {
    throw new Error("shop_not_enabled");
  }
  if (
    !input.snapshot ||
    input.now.getTime() - input.snapshot.verifiedAt.getTime() > TIKTOK_SHOP_SNAPSHOT_MAX_AGE_MS
  ) {
    throw new Error("commercial_snapshot_stale");
  }
};
