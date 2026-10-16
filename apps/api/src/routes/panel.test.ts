import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
const otherWorkspaceId = parseWorkspaceId("839c1caf-376d-4aa5-8e21-4e509106d03d");

const offer = {
  id: "offer-1",
  workspaceId,
  marketplace: "mercado_livre",
  affiliateUrl: "https://meli.la/x",
  title: "Offer",
  state: "active",
  activeSnapshotId: "s1",
  snapshots: [
    {
      id: "s1",
      verifiedAt: new Date("2026-09-20T12:00:00.000Z"),
      facts: [
        {
          key: "current_price",
          value: { amountMinor: 1000, currency: "BRL" },
          verified: true,
        },
      ],
    },
  ],
};
const variant = {
  id: "v1",
  workspaceId,
  contentItemId: "c1",
  channelId: "ch1",
  offerSnapshotId: "s1",
  assetIds: ["a1", "a2"],
  caption: "Caption",
  language: "pt-BR",
  state: "ready_for_review",
  creativeRender: {
    state: "rendered",
    reason: "in_scene_partial:attempts_exhausted:1:feed:product_absent",
    templateVersions: {},
    rendererVersion: 1,
    brandKitHash: "",
    fidelity: { verdict: "warn", slides: [] },
    quality: { verdict: "pass", slides: [] },
  },
};

const fixture = (
  overrides: { role?: string; downloads?: () => Promise<{ url: string }> } = {},
): ApiDependencies =>
  ({
    invitation: {},
    workspaces: {
      findByIdForMember: async (i: { workspaceId: string }) =>
        i.workspaceId === workspaceId ? { id: workspaceId, name: "W" } : null,
      findMembership: async () => ({
        workspaceId,
        userId,
        role: overrides.role ?? "operator",
        status: "active",
      }),
    },
    nicheRepository: {
      listForWorkspace: async () => [
        {
          id: "n1",
          name: "Niche",
          state: "active",
          languages: ["pt-BR"],
          slug: "niche",
        },
      ],
    },
    offerRepository: { listForWorkspace: async () => [offer] },
    channelRepository: {
      listForWorkspace: async () => [
        {
          id: "ch1",
          kind: "instagram_carousel",
          label: "IG",
          status: "active",
        },
      ],
    },
    assetRepository: {
      listForWorkspace: async () => [
        { id: "a1", width: 1080, height: 1080, mimeType: "image/jpeg" },
        { id: "a2", width: 1080, height: 1350, mimeType: "video/mp4" },
      ],
    },
    assetStore: {
      createDownload:
        overrides.downloads ??
        (async ({ assetId }: { assetId: string }) => ({
          url: `https://cdn/${assetId}`,
        })),
    },
    contentRepository: {
      listContentItemsForWorkspace: async () => [
        { id: "c1", nicheId: "n1", offerId: "offer-1", title: "Post" },
      ],
      listVariantsForWorkspace: async () => [variant],
    },
    providerConnections: {
      findAllForWorkspace: async () => [
        {
          id: "p1",
          provider: "post_for_me",
          mode: "api_key",
          status: "active",
          accountId: "acc",
        },
      ],
    },
    authenticate: async () => ({ userId, verifiedEmail: "o@example.com" }),
  }) as unknown as ApiDependencies;

const get = async (deps: ApiDependencies, id = workspaceId) => {
  const app = buildApp(deps);
  await app.ready();
  const response = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${id}/panel`,
  });
  await app.close();
  return response;
};

describe("panel route", () => {
  it("requires authentication", async () => {
    expect((await get({ ...fixture(), authenticate: async () => null })).statusCode).toBe(401);
  });

  it("hides other workspaces and denies unauthorized roles", async () => {
    expect((await get(fixture(), otherWorkspaceId)).statusCode).toBe(404);
    expect((await get(fixture({ role: "viewer" }))).statusCode).toBe(403);
  });

  it("returns the composed panel", async () => {
    const response = await get(fixture());
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.setup.stages).toBeInstanceOf(Array);
    expect(body.attribution).toBeNull();
    expect(body.performance).toBeNull();
    expect(body.niches[0]).toEqual({
      id: "n1",
      name: "Niche",
      slug: "niche",
      state: "active",
      languages: ["pt-BR"],
    });
    expect(body.channels[0]).toMatchObject({ id: "ch1", nicheId: null });
    expect(body.offers[0]).toMatchObject({
      id: "offer-1",
      nicheId: "n1",
      price: { amountMinor: 1000, currency: "BRL" },
      listPrice: null,
      verifiedAt: "2026-09-20T12:00:00.000Z",
      imageUrl: "https://cdn/a1",
    });
    expect(body.reviewQueue[0]).toMatchObject({
      id: "v1",
      title: "Post",
      channelLabel: "IG",
      policyMode: null,
      evidenceVerifiedAt: "2026-09-20T12:00:00.000Z",
      offer: { id: "offer-1", price: { amountMinor: 1000, currency: "BRL" } },
      images: [
        { url: "https://cdn/a1", width: 1080, height: 1080, mimeType: "image/jpeg" },
        { url: "https://cdn/a2", width: 1080, height: 1350, mimeType: "video/mp4" },
      ],
      qa: {
        render: {
          state: "rendered",
          reason: "in_scene_partial:attempts_exhausted:1:feed:product_absent",
          fidelity: "warn",
          quality: "pass",
        },
        reel: null,
        director: {
          level: "WARN",
          dimensions: { product: "WARN" },
          findings: [
            expect.objectContaining({ dimension: "product", repair: "redraw_scene" }),
            expect.objectContaining({ reason: "fidelity_warn", repair: "owner_review" }),
          ],
        },
      },
    });
    expect(body.variants[0]).toMatchObject({
      id: "v1",
      thumbnailUrl: "https://cdn/a1",
    });
    expect(body.connections[0]).toMatchObject({
      id: "p1",
      provider: "post_for_me",
    });
  });

  it("returns null image urls when the asset store fails", async () => {
    const response = await get(
      fixture({
        downloads: async () => {
          throw new Error("storage down");
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.reviewQueue[0].images).toEqual([]);
    expect(body.variants[0].thumbnailUrl).toBeNull();
    expect(body.offers[0].imageUrl).toBeNull();
  });
});
