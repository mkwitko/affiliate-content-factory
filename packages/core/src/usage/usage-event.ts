import type { WorkspaceId } from "@money-maker/contracts";

export type UsageEvent = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  provider: "cloudflare_workers_ai" | "cloudflare_images";
  unit: "neurons" | "transformations" | "requests";
  quantity: number;
  operation: string;
  correlationId?: string;
  createdAt: Date;
}>;
