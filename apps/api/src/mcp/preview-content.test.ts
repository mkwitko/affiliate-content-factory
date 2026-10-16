import { describe, expect, it } from "vitest";
import { previewContent } from "@money-maker/core/content/preview-content";
describe("preview_content MCP boundary", () => {
  it("discloses decorative CTA mode", () => {
    expect(
      previewContent({
        variant: {
          id: "v",
          workspaceId: "w" as never,
          contentItemId: "i",
          channelId: "c",
          offerSnapshotId: "s",
          assetIds: [],
          caption: "x",
          language: "pt-BR",
          state: "draft",
          voiceScript: [],
        },
        channel: {
          id: "c",
          workspaceId: "w" as never,
          connectionId: "x",
          kind: "threads",
          label: "Threads",
          status: "active",
          capabilities: {
            maxAssets: 1,
            requiresOrderedAssets: false,
            allowedMimeTypes: [],
            captionMaxLength: 500,
          },
        },
        assets: [],
        evidenceVerifiedAt: new Date(),
        destinationFingerprint: "sha",
      }).cta,
    ).toEqual({ mode: "decorative" });
  });
});
