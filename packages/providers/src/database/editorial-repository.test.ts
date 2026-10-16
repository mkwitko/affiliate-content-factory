import { parseWorkspaceId } from "@money-maker/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "./client.js";
import { PrismaEditorialRepository } from "./editorial-repository.js";

const workspaceId = parseWorkspaceId("11111111-1111-4111-8111-111111111111");

describe("PrismaEditorialRepository.listApprovedScripts", () => {
  it("reads only approved scripts of one workspace in a stable order", async () => {
    const findMany = vi.fn(async () => [
      {
        id: "s1",
        workspaceId,
        contentItemId: "item-1",
        version: 2,
        status: "APPROVED",
        body: "Body.",
        language: "pt-BR",
        claims: [],
        beats: [{ kind: "hook", atChar: 0 }],
        checksum: "c",
        createdAt: new Date(0),
        actorId: "22222222-2222-4222-8222-222222222222",
        approvedBy: null,
        approvedAt: new Date(1),
        approvedChecksum: "c",
      },
    ]);
    const client = { contentScript: { findMany } } as unknown as DatabaseClient;
    const scripts = await new PrismaEditorialRepository(client).listApprovedScripts({
      workspaceId,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId, status: "APPROVED" },
      orderBy: [{ contentItemId: "asc" }, { version: "desc" }, { id: "asc" }],
    });
    expect(scripts).toMatchObject([{ id: "s1", status: "approved", approvedChecksum: "c" }]);
  });
});
