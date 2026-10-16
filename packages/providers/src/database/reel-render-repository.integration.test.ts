import { parseWorkspaceId } from "@money-maker/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "./client.js";
import { createDatabaseClient } from "./client.js";
import { PrismaReelRenderRepository } from "./reel-render-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PrismaReelRenderRepository", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let repository: PrismaReelRenderRepository;

  beforeAll(() => {
    if (!databaseUrl) return;
    client = createDatabaseClient(databaseUrl);
    repository = new PrismaReelRenderRepository(client);
  });

  beforeEach(async () => {
    if (!client) return;
    // Other suites leave rows (publication attempts, audit events) that block a plain
    // deleteMany chain; every tenant row hangs off workspaces, so one cascade clears them.
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE');
  });

  afterAll(async () => {
    if (!client) return;
    // Leave no rows behind: other integration suites run in the same database and don't expect
    // a stray reelRender/contentVariant to survive when their own beforeEach runs.
    await client.$executeRawUnsafe('TRUNCATE TABLE "workspaces" CASCADE');
    await client.$disconnect();
  });

  const fixture = async (label: string) => {
    const workspace = await client.workspace.create({ data: { name: `Reel ${label}` } });
    const niche = await client.niche.create({
      data: {
        id: `niche-${label}`,
        workspaceId: workspace.id,
        name: "Home office",
        audience: "Remote workers",
        problem: "Uncomfortable desks",
        editorialVoice: "Practical",
        languages: ["pt-BR"],
        monetizationHypothesis: "Affiliate recommendations",
      },
    });
    const offer = await client.offer.create({
      data: {
        id: `offer-${label}`,
        workspaceId: workspace.id,
        marketplace: "MERCADO_LIVRE",
        listingUrl: "https://mercadolivre.example/item/1",
        title: "Desk accessory",
      },
    });
    const snapshot = await client.commercialSnapshot.create({
      data: {
        id: `snapshot-${label}`,
        offerId: offer.id,
        workspaceId: workspace.id,
        verifiedAt: new Date("2026-09-21T12:00:00.000Z"),
      },
    });
    const connection = await client.providerConnection.create({
      data: {
        workspaceId: workspace.id,
        provider: "POST_FOR_ME",
        mode: "API_KEY",
        secretReference: `secret://workspace/reel-${label}`,
        accountId: `account-${label}`,
      },
    });
    const channel = await client.channel.create({
      data: {
        id: `channel-${label}`,
        workspaceId: workspace.id,
        connectionId: connection.id,
        kind: "INSTAGRAM_CAROUSEL",
        label: "Feed",
        capabilities: {
          maxAssets: 10,
          requiresOrderedAssets: true,
          allowedMimeTypes: ["image/jpeg"],
          captionMaxLength: 2200,
        },
      },
    });
    const item = await client.contentItem.create({
      data: {
        id: `content-${label}`,
        workspaceId: workspace.id,
        nicheId: niche.id,
        offerId: offer.id,
        offerSnapshotId: snapshot.id,
        title: "Desk angle",
        sourceFactKeys: ["current_price"],
        creativeOpinion: "Lead with the use case.",
      },
    });
    const variant = await client.contentVariant.create({
      data: {
        id: `variant-${label}`,
        workspaceId: workspace.id,
        contentItemId: item.id,
        channelId: channel.id,
        offerSnapshotId: snapshot.id,
        assetIds: ["asset-1"],
        caption: "#publi A practical desk idea.",
        language: "pt-BR",
        state: "APPROVED",
      },
    });
    return { workspaceId: parseWorkspaceId(workspace.id), sourceVariantId: variant.id };
  };

  it("creates a pending render and is idempotent on a repeat call", async () => {
    const { workspaceId, sourceVariantId } = await fixture("a");
    const first = await repository.createPending({
      workspaceId,
      sourceVariantId,
      voiceMode: "script",
    });
    expect(first).toMatchObject({ created: true, render: { status: "pending" } });

    const second = await repository.createPending({
      workspaceId,
      sourceVariantId,
      voiceMode: "script",
    });
    expect(second).toMatchObject({ created: false, render: { id: first.render.id } });
  });

  it("finds no render before one is created", async () => {
    const { workspaceId, sourceVariantId } = await fixture("b");
    const found = await repository.findForWorkspace({ workspaceId, sourceVariantId });
    expect(found).toBeNull();
  });

  it("records ready with the rendered asset id", async () => {
    const { workspaceId, sourceVariantId } = await fixture("c");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    const ready = await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-reel-1",
      durationMs: 15_000,
    });
    expect(ready).toMatchObject({ status: "ready", assetId: "asset-reel-1" });
    const byAsset = await repository.findByAssetForWorkspace({
      workspaceId,
      assetId: "asset-reel-1",
    });
    expect(byAsset).toMatchObject({ sourceVariantId, assetId: "asset-reel-1" });
  });

  it("stores the music track and lists recent tracks newest first", async () => {
    const { workspaceId, sourceVariantId } = await fixture("m");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    const ready = await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-reel-m",
      musicTrackId: "casa/calm/a.mp3",
      durationMs: 15_000,
    });
    expect(ready).toMatchObject({ musicTrackId: "casa/calm/a.mp3" });
    await expect(repository.recentMusicTrackIds({ workspaceId, limit: 10 })).resolves.toEqual([
      "casa/calm/a.mp3",
    ]);
  });

  it("records a failure with a reason", async () => {
    const { workspaceId, sourceVariantId } = await fixture("d");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    const failed = await repository.recordFailed({
      workspaceId,
      sourceVariantId,
      reason: "reel_render_failed",
    });
    expect(failed).toMatchObject({ status: "failed", reason: "reel_render_failed" });
  });

  it("scopes lookups to the workspace", async () => {
    const first = await fixture("e");
    const second = await fixture("f");
    await repository.createPending({
      workspaceId: first.workspaceId,
      sourceVariantId: first.sourceVariantId,
      voiceMode: "script",
    });
    const crossWorkspace = await repository.findForWorkspace({
      workspaceId: second.workspaceId,
      sourceVariantId: first.sourceVariantId,
    });
    expect(crossWorkspace).toBeNull();
  });

  it("creates a pending render with a music-only voice mode", async () => {
    const { workspaceId, sourceVariantId } = await fixture("g");
    const created = await repository.createPending({
      workspaceId,
      sourceVariantId,
      voiceMode: "none",
    });
    expect(created).toMatchObject({ render: { voiceMode: "none", attempt: 1 } });
  });

  it("resets a failed render for retry with a new voice mode and bumped attempt", async () => {
    const { workspaceId, sourceVariantId } = await fixture("h");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    await repository.recordFailed({ workspaceId, sourceVariantId, reason: "reel_render_failed" });
    const reset = await repository.resetForRetry({
      workspaceId,
      sourceVariantId,
      voiceMode: "none",
    });
    expect(reset.status).toBe("pending");
    expect(reset.attempt).toBe(2);
    expect(reset.voiceMode).toBe("none");
    expect(reset.assetId).toBeUndefined();
    expect(reset.reason).toBeUndefined();
    expect(reset.musicTrackId).toBeUndefined();
    expect(reset.voiceId).toBeUndefined();
    expect(reset.durationMs).toBeUndefined();
  });

  it("keeps the first resolution when a late attempt records ready or failed", async () => {
    const { workspaceId, sourceVariantId } = await fixture("late");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-first",
      durationMs: 10_000,
    });
    const late = await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-late",
      durationMs: 11_000,
    });
    expect(late).toMatchObject({ status: "ready", assetId: "asset-first", durationMs: 10_000 });
    const failed = await repository.recordFailed({
      workspaceId,
      sourceVariantId,
      reason: "render_timeout",
    });
    expect(failed).toMatchObject({ status: "ready", assetId: "asset-first" });
  });

  it("never resets a render that already became ready", async () => {
    const { workspaceId, sourceVariantId } = await fixture("j");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    const ready = await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-reel-j",
      durationMs: 12_000,
    });
    expect(ready.status).toBe("ready");

    const reset = await repository.resetForRetry({
      workspaceId,
      sourceVariantId,
      voiceMode: "none",
    });

    expect(reset.status).toBe("ready");
    expect(reset.attempt).toBe(ready.attempt);
    expect(reset.assetId).toBe("asset-reel-j");
  });

  it("records ready with a voice id and duration", async () => {
    const { workspaceId, sourceVariantId } = await fixture("i");
    await repository.createPending({ workspaceId, sourceVariantId, voiceMode: "script" });
    const ready = await repository.recordReady({
      workspaceId,
      sourceVariantId,
      assetId: "asset-reel-i",
      voiceId: "pf_dora",
      durationMs: 21_400,
    });
    expect(ready).toMatchObject({ voiceId: "pf_dora", durationMs: 21_400 });
  });
});
