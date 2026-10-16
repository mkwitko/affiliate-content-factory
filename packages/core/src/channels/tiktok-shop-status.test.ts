import { describe, expect, it } from "vitest";
import {
  accountStrategyFor,
  assertTikTokShopPublishable,
  effectiveShopState,
  parseTikTokShopStatus,
  recordTikTokShopStatus,
  shopTrackFor,
  type TikTokShopStatus,
} from "./tiktok-shop-status.js";

const now = new Date("2026-09-28T12:00:00.000Z");

describe("parseTikTokShopStatus", () => {
  it("returns null when the context has no tiktokShop key", () => {
    expect(parseTikTokShopStatus(null)).toBeNull();
    expect(parseTikTokShopStatus(undefined)).toBeNull();
    expect(parseTikTokShopStatus({})).toBeNull();
  });

  it("returns null for malformed stored data instead of inventing a status", () => {
    expect(parseTikTokShopStatus({ tiktokShop: { version: 2, state: "shop_enabled" } })).toBeNull();
    expect(parseTikTokShopStatus({ tiktokShop: { version: 1, state: "made_up" } })).toBeNull();
    expect(
      parseTikTokShopStatus({
        tiktokShop: { version: 1, state: "shop_enabled", observedAt: "nope" },
      }),
    ).toBeNull();
  });

  it("round-trips a valid stored status", () => {
    const stored = {
      version: 1,
      state: "shop_enabled",
      observedAt: now.toISOString(),
      source: "operator_confirmation",
    };
    expect(parseTikTokShopStatus({ role: "growth", tiktokShop: stored })).toEqual(stored);
  });
});

describe("recordTikTokShopStatus", () => {
  it("requires a reason for not_eligible", () => {
    expect(() => recordTikTokShopStatus(null, { state: "not_eligible" }, now)).toThrow(
      "shop_status_reason_required",
    );
  });

  it("accepts not_eligible with a reason", () => {
    const status = recordTikTokShopStatus(
      null,
      { state: "not_eligible", reason: "followers" },
      now,
    );
    expect(status).toMatchObject({ state: "not_eligible", reason: "followers" });
  });

  it("rejects a note longer than 500 characters", () => {
    expect(() =>
      recordTikTokShopStatus(null, { state: "shop_enabled", note: "a".repeat(501) }, now),
    ).toThrow("shop_status_note_too_long");
  });

  it("rejects a note containing an 11-digit CPF-like number, with or without punctuation", () => {
    expect(() =>
      recordTikTokShopStatus(null, { state: "shop_enabled", note: "CPF 123.456.789-01" }, now),
    ).toThrow("shop_status_note_sensitive");
    expect(() =>
      recordTikTokShopStatus(null, { state: "shop_enabled", note: "cpf 12345678901 mesmo" }, now),
    ).toThrow("shop_status_note_sensitive");
  });

  it("rejects a note containing a 14-digit CNPJ-like number, with or without punctuation", () => {
    expect(() =>
      recordTikTokShopStatus(null, { state: "shop_enabled", note: "CNPJ 12.345.678/0001-95" }, now),
    ).toThrow("shop_status_note_sensitive");
    expect(() =>
      recordTikTokShopStatus(null, { state: "shop_enabled", note: "12345678000195" }, now),
    ).toThrow("shop_status_note_sensitive");
  });

  it("accepts a plain note and stamps observedAt/source", () => {
    const status = recordTikTokShopStatus(
      null,
      { state: "shop_enabled", note: "Confirmado no app hoje" },
      now,
    );
    expect(status).toEqual({
      version: 1,
      state: "shop_enabled",
      note: "Confirmado no app hoje",
      observedAt: now.toISOString(),
      source: "operator_confirmation",
    });
  });
});

describe("effectiveShopState", () => {
  it("is unknown when no status was ever recorded", () => {
    expect(effectiveShopState(null, now)).toBe("unknown");
  });

  it("is the recorded state within 30 days", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    const later = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000);
    expect(effectiveShopState(status, later)).toBe("shop_enabled");
  });

  it("falls back to unknown after 30 days", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    const later = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(effectiveShopState(status, later)).toBe("unknown");
  });
});

describe("shopTrackFor", () => {
  it("maps each non-not_eligible state to its track", () => {
    expect(shopTrackFor("unknown")).toBe("manual_diagnosis");
    expect(shopTrackFor("not_connected")).toBe("setup");
    expect(shopTrackFor("eligible_not_onboarded")).toBe("setup");
    expect(shopTrackFor("onboarding")).toBe("verification");
    expect(shopTrackFor("shop_enabled")).toBe("selling");
    expect(shopTrackFor("restricted")).toBe("compliance");
    expect(shopTrackFor("suspended")).toBe("compliance");
  });

  it("maps not_eligible by reason", () => {
    expect(shopTrackFor("not_eligible", "followers")).toBe("growth");
    expect(shopTrackFor("not_eligible", "age")).toBe("growth");
    expect(shopTrackFor("not_eligible", "region")).toBe("manual_diagnosis");
    expect(shopTrackFor("not_eligible", "account_type")).toBe("setup");
    expect(shopTrackFor("not_eligible", "identity")).toBe("verification");
    expect(shopTrackFor("not_eligible", "policy")).toBe("compliance");
    expect(shopTrackFor("not_eligible", "unknown")).toBe("manual_diagnosis");
    expect(shopTrackFor("not_eligible")).toBe("manual_diagnosis");
  });
});

describe("assertTikTokShopPublishable", () => {
  const channelWithStatus = (status: TikTokShopStatus | null) => ({
    context: status ? { tiktokShop: status } : null,
  });
  const freshSnapshot = { id: "s1", verifiedAt: now, facts: [] };

  it("is a no-op for a non-tiktok_shop offer", () => {
    expect(() =>
      assertTikTokShopPublishable({
        channel: { context: null },
        offer: { marketplace: "mercado_livre" },
        snapshot: null,
        now,
      }),
    ).not.toThrow();
  });

  it("throws shop_not_enabled when no status was ever recorded", () => {
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(null),
        offer: { marketplace: "tiktok_shop" },
        snapshot: freshSnapshot,
        now,
      }),
    ).toThrow("shop_not_enabled");
  });

  it("throws shop_not_enabled when the recorded status is not shop_enabled", () => {
    const status = recordTikTokShopStatus(null, { state: "onboarding" }, now);
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(status),
        offer: { marketplace: "tiktok_shop" },
        snapshot: freshSnapshot,
        now,
      }),
    ).toThrow("shop_not_enabled");
  });

  it("throws shop_not_enabled when the recorded status is older than 30 days", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    const later = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(status),
        offer: { marketplace: "tiktok_shop" },
        snapshot: { ...freshSnapshot, verifiedAt: later },
        now: later,
      }),
    ).toThrow("shop_not_enabled");
  });

  it("throws commercial_snapshot_stale when there is no snapshot", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(status),
        offer: { marketplace: "tiktok_shop" },
        snapshot: null,
        now,
      }),
    ).toThrow("commercial_snapshot_stale");
  });

  it("throws commercial_snapshot_stale when the snapshot is older than 24h", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    const later = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(status),
        offer: { marketplace: "tiktok_shop" },
        snapshot: freshSnapshot,
        now: later,
      }),
    ).toThrow("commercial_snapshot_stale");
  });

  it("passes when the status is shop_enabled and the snapshot is fresh", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    expect(() =>
      assertTikTokShopPublishable({
        channel: channelWithStatus(status),
        offer: { marketplace: "tiktok_shop" },
        snapshot: freshSnapshot,
        now,
      }),
    ).not.toThrow();
  });
});

describe("accountStrategyFor", () => {
  it("sells TikTok Shop only while shop_enabled is current", () => {
    const status = recordTikTokShopStatus(null, { state: "shop_enabled" }, now);
    expect(accountStrategyFor(status, now)).toBe("sell_tiktok_shop");
    const later = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(accountStrategyFor(status, later)).toBe("grow_audience");
  });

  it("sells Mercado Livre through the bio link when Shop is unavailable but a bio link is", () => {
    const status = recordTikTokShopStatus(
      null,
      { state: "not_eligible", reason: "followers", bioLinkAvailable: true },
      now,
    );
    expect(status.bioLinkAvailable).toBe(true);
    expect(parseTikTokShopStatus({ tiktokShop: status })).toEqual(status);
    expect(accountStrategyFor(status, now)).toBe("sell_mercado_livre");
  });

  it("grows the audience when nothing sells yet or the status is unknown", () => {
    expect(accountStrategyFor(null, now)).toBe("grow_audience");
    const status = recordTikTokShopStatus(
      null,
      { state: "not_eligible", reason: "followers", bioLinkAvailable: false },
      now,
    );
    expect(accountStrategyFor(status, now)).toBe("grow_audience");
  });
});
