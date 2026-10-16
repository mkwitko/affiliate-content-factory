import { z } from "zod";

declare const userIdBrand: unique symbol;
declare const workspaceIdBrand: unique symbol;

export type UserId = string & { readonly [userIdBrand]: true };
export type WorkspaceId = string & { readonly [workspaceIdBrand]: true };
export type MembershipRole = "owner" | "operator" | "reviewer";

const userIdSchema = z.uuid({ error: "UserId must be a valid UUID" });
const workspaceIdSchema = z.uuid({ error: "WorkspaceId must be a valid UUID" });

export const parseUserId = (input: unknown): UserId => userIdSchema.parse(input) as UserId;

export const parseWorkspaceId = (input: unknown): WorkspaceId =>
  workspaceIdSchema.parse(input) as WorkspaceId;
