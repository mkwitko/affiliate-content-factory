import type { UserId } from "@money-maker/contracts";
import type { ToolResult } from "../server.js";

export type ProfileActor = Readonly<{ userId: UserId; verifiedEmail: string }>;

export const getProfileTool = async (actor: ProfileActor): Promise<ToolResult> => ({
  ok: true,
  // OpenAI profile contract: the internal user id is the stable opaque profile id.
  value: { id: actor.userId, email: actor.verifiedEmail },
});
