import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { requireList } from "./workspace-access.js";

describe("requireList", () => {
  it("keeps class-based repositories bound to their instance", async () => {
    class Repository {
      private readonly items = ["niche"];
      public async listForWorkspace(_workspaceId: WorkspaceId): Promise<readonly string[]> {
        return this.items;
      }
    }

    const list = requireList(new Repository());

    await expect(list(parseWorkspaceId("7fb9427e-8d67-49aa-80f6-ec915bea7206"))).resolves.toEqual([
      "niche",
    ]);
  });
});
