import { parseUserId } from "@money-maker/contracts";
import { describe, expect, it } from "vitest";
import { getProfileTool } from "./tools/get-profile.js";

describe("get_profile", () => {
  it("returns the OpenAI profile shape with a stable opaque id", async () => {
    const actor = {
      userId: parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707"),
      verifiedEmail: "owner@example.com",
    };

    await expect(getProfileTool(actor)).resolves.toEqual({
      ok: true,
      value: { id: actor.userId, email: actor.verifiedEmail },
    });
  });
});
