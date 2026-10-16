import { parseWorkspaceId } from "@money-maker/contracts";
import type { Offer } from "@money-maker/core/offers/offer";
import { describe, expect, it } from "vitest";
import { publicOffer } from "./offer-output.js";

const snapshot = (id: string, day: number) => ({
  id,
  verifiedAt: new Date(Date.UTC(2026, 9, day)),
  facts: [{ key: "price", value: day, sourceUrl: "https://ml/p", verified: true }],
});
const offer = (activeSnapshotId?: string): Offer => ({
  id: "offer-1",
  workspaceId: parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d"),
  marketplace: "mercado_livre",
  listingUrl: "https://ml/p",
  title: "Organizador",
  state: "active",
  snapshots: [snapshot("old", 1), snapshot("active", 2), snapshot("newest", 3)],
  ...(activeSnapshotId ? { activeSnapshotId } : {}),
});

describe("publicOffer", () => {
  it("shows the active snapshot and how many exist, never the whole refresh history", () => {
    const shown = publicOffer(offer("active"));
    expect(shown.snapshotCount).toBe(3);
    expect(shown.snapshots.map((entry) => entry.id)).toEqual(["active"]);
  });

  it("shows the newest snapshot when none is active", () => {
    expect(publicOffer(offer()).snapshots.map((entry) => entry.id)).toEqual(["newest"]);
  });
});
