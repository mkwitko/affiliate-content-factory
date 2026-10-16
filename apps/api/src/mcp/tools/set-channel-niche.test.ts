import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { Channel } from "@money-maker/core/channels/channel";
import { describe, expect, it } from "vitest";
import type { McpDependencies } from "../server.js";
import { setChannelNicheTool } from "./set-channel-niche.js";

const actorId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const setup = (role: "owner" | "operator") => {
  let stored = { id: "ch1", workspaceId, nicheId: null } as unknown as Channel;
  const audits: unknown[] = [];
  const deps = {
    authenticate: async () => ({ userId: actorId }),
    workspaces: {
      findMembership: async () => ({ workspaceId, userId: actorId, role, status: "active" }),
    },
    nicheRepository: {
      findForWorkspace: async ({ nicheId }: { nicheId: string }) =>
        nicheId === "casa" ? { id: "casa" } : null,
    },
    channelRepository: {
      findForWorkspace: async () => stored,
      setNiche: async ({ nicheId }: { nicheId: string | null }) => {
        stored = { ...stored, nicheId };
        return stored;
      },
    },
    audit: {
      record: async (event: unknown) => {
        audits.push(event);
        return "a1";
      },
    },
  } as unknown as McpDependencies;
  return { deps, audits, stored: () => stored };
};

describe("set_channel_niche", () => {
  it("binds a channel to a workspace niche for the owner and audits it", async () => {
    const { deps, audits, stored } = setup("owner");
    const result = await setChannelNicheTool(
      { workspaceId, channelId: "ch1", nicheId: "casa" },
      actorId,
      deps,
    );
    expect(result).toMatchObject({ ok: true, value: { channel: { nicheId: "casa" } } });
    expect(stored().nicheId).toBe("casa");
    expect(audits).toEqual([
      expect.objectContaining({
        action: "channel.niche_set",
        metadata: { from: "none", to: "casa" },
      }),
    ]);
  });

  it("refuses an operator and a niche outside the workspace", async () => {
    const operator = setup("operator");
    expect(
      await setChannelNicheTool(
        { workspaceId, channelId: "ch1", nicheId: "casa" },
        actorId,
        operator.deps,
      ),
    ).toMatchObject({ ok: false });
    expect(operator.stored().nicheId).toBeNull();
    const owner = setup("owner");
    expect(
      await setChannelNicheTool(
        { workspaceId, channelId: "ch1", nicheId: "other" },
        actorId,
        owner.deps,
      ),
    ).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});
